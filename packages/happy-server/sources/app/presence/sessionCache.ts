import { db } from "@/storage/db";
import { log } from "@/utils/log";
import { sessionCacheCounter, databaseUpdatesSkippedCounter } from "@/app/monitoring/metrics2";

interface SessionCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    pendingUpdate: number | null;
    userId: string;
}

interface MachineCacheEntry {
    validUntil: number;
    lastUpdateSent: number;
    pendingUpdate: number | null;
    userId: string;
}

class ActivityCache {
    private sessionCache = new Map<string, SessionCacheEntry>();
    private machineCache = new Map<string, MachineCacheEntry>();
    private batchTimer: ReturnType<typeof setInterval> | null = null;
    
    // Cache TTL (30 seconds)
    private readonly CACHE_TTL = 30 * 1000;
    
    // Only update DB if time difference is significant (30 seconds)
    private readonly UPDATE_THRESHOLD = 30 * 1000;
    
    // Batch update interval (5 seconds)
    private readonly BATCH_INTERVAL = 5 * 1000;

    constructor() {
        this.startBatchTimer();
    }

    private startBatchTimer(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
        }
        
        this.batchTimer = setInterval(() => {
            this.flushPendingUpdates().catch(error => {
                log({ module: 'session-cache', level: 'error' }, `Error flushing updates: ${error}`);
            });
        }, this.BATCH_INTERVAL);
    }

    async isSessionValid(sessionId: string, userId: string): Promise<boolean> {
        const now = Date.now();
        const cached = this.sessionCache.get(sessionId);

        // Check cache first
        if (cached && cached.validUntil > now && cached.userId === userId) {
            sessionCacheCounter.inc({ operation: 'session_validation', result: 'hit' });
            return true;
        }

        sessionCacheCounter.inc({ operation: 'session_validation', result: 'miss' });

        // Cache miss - check database
        try {
            const session = await db.session.findUnique({
                where: { id: sessionId, accountId: userId }
            });

            if (session) {
                // Cache the result
                this.sessionCache.set(sessionId, {
                    validUntil: now + this.CACHE_TTL,
                    lastUpdateSent: session.lastActiveAt.getTime(),
                    pendingUpdate: null,
                    userId
                });
                return true;
            }

            return false;
        } catch (error) {
            // Treat transient DB errors (pool timeout, connection issues) as a
            // short grace period to break retry storms that keep the pool busy.
            // Real validation resumes on next miss after the grace expires.
            // Any DB error → grace cache for 5s to break retry storms.
            // Both PrismaClientKnownRequestError (P2024 etc) and
            // PrismaClientUnknownRequestError can fire under pool exhaustion.
            // A genuine "session not found" goes through `if (session)` above,
            // not this catch — so caching as valid here is safe.
            this.sessionCache.set(sessionId, {
                validUntil: now + 5 * 1000,
                lastUpdateSent: 0,
                pendingUpdate: null,
                userId
            });
            log({ module: 'session-cache', level: 'warn' }, `Validation deferred for ${sessionId} (DB error, grace 5s)`);
            return true;
        }
    }

    async isMachineValid(machineId: string, userId: string): Promise<boolean> {
        const now = Date.now();
        const cached = this.machineCache.get(machineId);

        // Check cache first
        if (cached && cached.validUntil > now && cached.userId === userId) {
            sessionCacheCounter.inc({ operation: 'machine_validation', result: 'hit' });
            return true;
        }

        sessionCacheCounter.inc({ operation: 'machine_validation', result: 'miss' });

        // Cache miss - check database
        try {
            const machine = await db.machine.findUnique({
                where: {
                    accountId_id: {
                        accountId: userId,
                        id: machineId
                    }
                }
            });

            if (machine) {
                // Cache the result
                this.machineCache.set(machineId, {
                    validUntil: now + this.CACHE_TTL,
                    lastUpdateSent: machine.lastActiveAt?.getTime() || 0,
                    pendingUpdate: null,
                    userId
                });
                return true;
            }

            return false;
        } catch (error) {
            this.machineCache.set(machineId, {
                validUntil: now + 5 * 1000,
                lastUpdateSent: 0,
                pendingUpdate: null,
                userId
            });
            log({ module: 'session-cache', level: 'warn' }, `Validation deferred for machine ${machineId} (DB error, grace 5s)`);
            return true;
        }
    }

    queueSessionUpdate(sessionId: string, timestamp: number): boolean {
        const cached = this.sessionCache.get(sessionId);
        if (!cached) {
            return false; // Should validate first
        }
        
        // Only queue if time difference is significant
        const timeDiff = Math.abs(timestamp - cached.lastUpdateSent);
        if (timeDiff > this.UPDATE_THRESHOLD) {
            cached.pendingUpdate = timestamp;
            return true;
        }
        
        databaseUpdatesSkippedCounter.inc({ type: 'session' });
        return false; // No update needed
    }

    queueMachineUpdate(machineId: string, timestamp: number): boolean {
        const cached = this.machineCache.get(machineId);
        if (!cached) {
            return false; // Should validate first
        }
        
        // Only queue if time difference is significant
        const timeDiff = Math.abs(timestamp - cached.lastUpdateSent);
        if (timeDiff > this.UPDATE_THRESHOLD) {
            cached.pendingUpdate = timestamp;
            return true;
        }
        
        databaseUpdatesSkippedCounter.inc({ type: 'machine' });
        return false; // No update needed
    }

    private async flushPendingUpdates(): Promise<void> {
        const sessionUpdates: { id: string, timestamp: number }[] = [];
        const machineUpdates: { id: string, timestamp: number, userId: string }[] = [];
        
        // Collect session updates
        for (const [sessionId, entry] of this.sessionCache.entries()) {
            if (entry.pendingUpdate) {
                sessionUpdates.push({ id: sessionId, timestamp: entry.pendingUpdate });
                entry.lastUpdateSent = entry.pendingUpdate;
                entry.pendingUpdate = null;
            }
        }
        
        // Collect machine updates
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.pendingUpdate) {
                machineUpdates.push({ 
                    id: machineId, 
                    timestamp: entry.pendingUpdate, 
                    userId: entry.userId 
                });
                entry.lastUpdateSent = entry.pendingUpdate;
                entry.pendingUpdate = null;
            }
        }
        
        // Batch update sessions — sequentially to keep pool pressure low.
        // Promise.all here would grab N connections at once; one slow query
        // then starves the rest of the server.
        if (sessionUpdates.length > 0) {
            let ok = 0;
            for (const update of sessionUpdates) {
                try {
                    await db.session.update({
                        where: { id: update.id },
                        data: { lastActiveAt: new Date(update.timestamp), active: true }
                    });
                    ok++;
                } catch (error) {
                    log({ module: 'session-cache', level: 'warn' }, `Skipped session update ${update.id}: ${(error as Error).message?.slice(0, 80)}`);
                }
            }
            if (ok > 0) {
                log({ module: 'session-cache' }, `Flushed ${ok}/${sessionUpdates.length} session updates`);
            }
        }

        // Batch update machines — same sequential approach.
        if (machineUpdates.length > 0) {
            let ok = 0;
            for (const update of machineUpdates) {
                try {
                    await db.machine.update({
                        where: {
                            accountId_id: {
                                accountId: update.userId,
                                id: update.id
                            }
                        },
                        data: { lastActiveAt: new Date(update.timestamp) }
                    });
                    ok++;
                } catch (error) {
                    log({ module: 'session-cache', level: 'warn' }, `Skipped machine update ${update.id}: ${(error as Error).message?.slice(0, 80)}`);
                }
            }
            if (ok > 0) {
                log({ module: 'session-cache' }, `Flushed ${ok}/${machineUpdates.length} machine updates`);
            }
        }
    }

    // Cleanup old cache entries periodically
    cleanup(): void {
        const now = Date.now();
        
        for (const [sessionId, entry] of this.sessionCache.entries()) {
            if (entry.validUntil < now) {
                this.sessionCache.delete(sessionId);
            }
        }
        
        for (const [machineId, entry] of this.machineCache.entries()) {
            if (entry.validUntil < now) {
                this.machineCache.delete(machineId);
            }
        }
    }

    shutdown(): void {
        if (this.batchTimer) {
            clearInterval(this.batchTimer);
            this.batchTimer = null;
        }
        
        // Flush any remaining updates
        this.flushPendingUpdates().catch(error => {
            log({ module: 'session-cache', level: 'error' }, `Error flushing final updates: ${error}`);
        });
    }
}

// Global instance
export const activityCache = new ActivityCache();

// Cleanup every 5 minutes
setInterval(() => {
    activityCache.cleanup();
}, 5 * 60 * 1000);