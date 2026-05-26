require('dotenv').config();
const { Redis } = require('@upstash/redis');

// Initialize Upstash Redis client
// Expects UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in .env or environment
const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const PENDING_QUEUE_KEY = 'standalone_pending_pins';
const SCRAPED_SET_KEY = 'standalone_scraped_pins';

const insertPin = async (pin, destinationChannel) => {
    // Check if we already scraped this pin to prevent duplicates
    const alreadyScraped = await redis.sismember(SCRAPED_SET_KEY, pin.id);
    if (alreadyScraped) {
        return 0; // Skip
    }

    const pinPayload = JSON.stringify({
        ...pin,
        destination_channel_name: destinationChannel,
        status: 'pending',
        created_at: new Date().toISOString()
    });

    // Push to the end of the pending queue
    await redis.rpush(PENDING_QUEUE_KEY, pinPayload);
    // Mark as scraped globally
    await redis.sadd(SCRAPED_SET_KEY, pin.id);
    
    return 1;
};

const getNextPendingPin = async () => {
    // Pop the first item off the left of the queue
    const pinPayload = await redis.lpop(PENDING_QUEUE_KEY);
    if (!pinPayload) return null;
    
    return pinPayload; // Already parsed by Upstash client usually, but if string, we parse it
};

const updatePinStatus = async (pin, status) => {
    // If a pin fails, we might want to push it back to the queue or save it somewhere else.
    // For this free version, if it succeeds it's already popped. 
    // If it fails, we push it back to the end of the queue so it can be retried later.
    if (status === 'failed') {
        await redis.rpush(PENDING_QUEUE_KEY, JSON.stringify(pin));
    }
};

module.exports = {
    insertPin,
    getNextPendingPin,
    updatePinStatus
};
