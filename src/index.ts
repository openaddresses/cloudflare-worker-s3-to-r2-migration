import { Hono } from 'hono';
import { cache } from 'hono/cache';
import { AwsClient } from 'aws4fetch';

// Define environment interface
interface Env {
    R2: R2Bucket;
    R2_OBJECT_PREFIX: string;
    OA_USAGE: KVNamespace;
    AWS_ACCESS_KEY_ID: string;
    AWS_SECRET_ACCESS_KEY: string;
    AWS_SERVICE: string;
    AWS_DEFAULT_REGION: string;
    AWS_S3_BUCKET: string;
    AWS_S3_BUCKET_SCHEME: string;
}

interface UsageData {
    usage: number;
    timestamp: number;
}

const MAX_USAGE = 5 * 1024 * 1024 * 1024; // 5 GB
const USAGE_WINDOW = 24 * 60 * 60 * 1000; // 24 hours

const hostToBucketMapping = {
    'v2.openaddresses.io': {
        s3_bucket: 'v2.openaddresses.io',
        block_root: true,
    },
    'results.openaddresses.io': {
        s3_bucket: 'results.openaddresses.io',
        index_file: 'index.html',
        cache_control: 'public, max-age=604800, immutable',
    },
    'data.openaddresses.io': {
        s3_bucket: 'data.openaddresses.io',
        block_root: true,
    },
};

const amzRedirectLocationHeaderName = 'x-amz-website-redirect-location';

// Extract client fingerprint from request
function getClientFingerprint(request: Request): string {
    const tlsFingerprint = request.cf.tlsClientExtensionsSha1 || 'unknown';
    const asn = request.cf.asn || 'unknown';

    // Combine TLS fingerprint with ASN for more accurate identification
    return `${tlsFingerprint}:${asn}`;
}

// Track usage by fingerprint
async function trackFingerprintUsage(env: Env, request: Request, bytes: number): Promise<void> {
    const fingerprint = getClientFingerprint(request);
    const fingerprintKey = `fp:${fingerprint}`;

    const usageData = await env.OA_USAGE.get(fingerprintKey, { type: 'json' }) as UsageData | null;
    const now = Date.now();
    let newUsage = bytes;

    if (usageData) {
        const { usage, timestamp } = usageData;
        if (now - timestamp <= USAGE_WINDOW) {
            newUsage += usage;
        }
    }

    await env.OA_USAGE.put(
        fingerprintKey,
        JSON.stringify({
            usage: newUsage,
            timestamp: now,
        })
    );
}

// Check if client exceeds limits
async function checkFingerprintUsage(env: Env, request: Request): Promise<boolean> {
    const fingerprint = getClientFingerprint(request);
    const fingerprintKey = `fp:${fingerprint}`;

    const usageData = await env.OA_USAGE.get(fingerprintKey, { type: 'json' }) as UsageData | null;
    if (!usageData) return false;

    const { usage, timestamp } = usageData;
    const now = Date.now();

    if (now - timestamp > USAGE_WINDOW) return false;

    // If the same TLS fingerprint is downloading a lot across different IPs, it's likely abuse
    return usage >= MAX_USAGE;
}

function sanitizePath(path: string): string {
    // Remove any control characters and non-ASCII characters
    let sanitized = path.replace(/[\x00-\x1F\x7F-\xFF]/g, '');

    // Remove any URL-encoded versions of control characters
    sanitized = sanitized.replace(/%[0-1][0-9A-Fa-f]/g, '');

    // Normalize multiple slashes to a single slash
    sanitized = sanitized.replace(/\/+/g, '/');

    // Prevent directory traversal attempts
    sanitized = sanitized
        .split('/')
        .filter((part) => {
            return part !== '..' && part !== '.';
        })
        .join('/');

    // Optional: Only allow specific characters
    sanitized = sanitized.replace(/[^a-zA-Z0-9_\-\.\/]/g, '');

    return sanitized;
}

// Create Hono app
const app = new Hono<{ Bindings: Env }>();

// Global middleware
app.use(async (c, next) => {
    const ip = c.req.header('CF-Connecting-IP');
    if (!ip) {
        return c.text('IP address not found', 400);
    }

    await next();
});

// Cache middleware
app.use('*', cache({
    cacheName: 'default',
    cacheControl: 'public, max-age=3600',
}));

// Main handler
app.get('*', async (c) => {
    const { req, env } = c;
    const cache = caches.default;
    const cacheKey = new Request(req.url, req);
    const overallCacheResponse = await cache.match(cacheKey);

    if (overallCacheResponse) {
        console.log('Cache matched');
        return overallCacheResponse;
    }

    const url = new URL(req.url);
    const hostName = url.hostname;
    let s3objectName = url.pathname.slice(1);
    s3objectName = sanitizePath(s3objectName);

    // Block requests with control characters or non-ASCII characters
    if (/[\x00-\x1F\x7F-\xFF]/.test(s3objectName) || /%[0-1][0-9A-Fa-f]/.test(s3objectName)) {
        const resp = new Response(`Invalid request`, { status: 400 });
        c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
    }

    // Require a referer header for requests to data.openaddresses.io/runs
    const referer = req.header('referer');
    if (hostName === 'data.openaddresses.io' && s3objectName.startsWith('runs/') && !referer) {
        const resp = new Response(`Invalid request`, { status: 403 });
        c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
    }

    const config = hostToBucketMapping[hostName];
    if (!config) {
        const resp = new Response(`Unknown host`, { status: 404 });
        c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
    }

    if (s3objectName == '' || s3objectName.endsWith('/')) {
        if (config.block_root) {
            const resp = new Response(`Bad Request`, { status: 400 });
            c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
            return resp;
        }

        if (config.index_file && (s3objectName == '' || s3objectName.endsWith('/'))) {
            s3objectName += config.index_file;
        }
    }

    const r2prefix = config.s3_bucket + '/';
    const r2objectName = r2prefix + s3objectName;

    if (r2objectName === '') {
        const resp = new Response(`Bad Request`, { status: 400 });
        c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
    }

    if (req.method !== 'GET') {
        const resp = new Response(`Method Not Allowed`, { status: 405 });
        c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
    }

    const objHeadResp = await env.R2.head(r2objectName);

    if (objHeadResp === null) {
        const fingerprintExceedsLimits = await checkFingerprintUsage(env, req.raw);
        if (fingerprintExceedsLimits) {
            console.log(`Download limit exceeded for ${req.header('CF-Connecting-IP')}`);
            return new Response('Download limit exceeded', { status: 429 });
        }

        console.log(`Fetching from S3: s3://${config.s3_bucket}/${s3objectName}`);

        const aws = new AwsClient({
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            service: env.AWS_SERVICE,
            region: env.AWS_DEFAULT_REGION,
        });

        const requestToSign = new Request(`https://s3.us-east-1.amazonaws.com/${config.s3_bucket}/${s3objectName}`);
        const signedRequest = await aws.sign(requestToSign);
        const s3Object = await fetch(signedRequest);

        if (s3Object.status === 404) {
            const resp = new Response(`Object ${s3objectName} not found`, { status: 404 });
            c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
            return resp;
        }

        let dataForR2, dataForResponse;

        const customMetadata = {};
        const redirectTo = s3Object.headers.get(amzRedirectLocationHeaderName);
        if (redirectTo) {
            customMetadata[amzRedirectLocationHeaderName] = redirectTo;
        }

        if (s3Object.headers.get('content-length') == null) {
            dataForR2 = await s3Object.text();
            dataForResponse = dataForR2;
        } else {
            const s3Body = s3Object.body.tee();
            dataForR2 = s3Body[0];
            dataForResponse = s3Body[1];

            // Track S3 data usage per IP address
            const contentLength = parseInt(s3Object.headers.get('content-length') || '0', 10);
            await trackFingerprintUsage(env, req.raw, contentLength);
        }

        console.log(`Saving to R2: ${r2objectName}`);

        c.executionCtx.waitUntil(
            env.R2.put(r2objectName, dataForR2, {
                httpMetadata: s3Object.headers,
                customMetadata: customMetadata,
            })
        );

        if (redirectTo) {
            const resp = Response.redirect(redirectTo, 302);
            c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
            return resp;
        }

        // Clone the response so that it's no longer immutable
        const newResponse = new Response(dataForResponse, s3Object);
        if (config.cache_control) {
            newResponse.headers.set('cache-control', config.cache_control);
        }

        c.executionCtx.waitUntil(cache.put(cacheKey, newResponse.clone()));

        return newResponse;
    }

    if (objHeadResp.customMetadata[amzRedirectLocationHeaderName]) {
        console.log(`R2 says to redirect to ${objHeadResp.customMetadata[amzRedirectLocationHeaderName]}`);
        const resp = Response.redirect(objHeadResp.customMetadata[amzRedirectLocationHeaderName], 302);
        c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
    }

    console.log(`Fetching from R2: ${r2objectName}`);

    const obj = await env.R2.get(r2objectName);

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    if (config.cache_control) {
        headers.set('cache-control', config.cache_control);
    }
    headers.set('etag', obj.httpEtag);
    const resp = new Response(obj.body, { headers });
    c.executionCtx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
});

export default app;
