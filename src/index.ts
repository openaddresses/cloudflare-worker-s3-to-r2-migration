import { AwsClient } from "aws4fetch";

interface Env {
    R2: R2Bucket,
    R2_OBJECT_PREFIX: string,
    OA_USAGE: KVNamespace,
    AWS_ACCESS_KEY_ID: string,
    AWS_SECRET_ACCESS_KEY: string,
    AWS_SERVICE: string,
    AWS_DEFAULT_REGION: string,
    AWS_S3_BUCKET: string
    AWS_S3_BUCKET_SCHEME: string
}

interface UsageData {
    usage: number;
    timestamp: number;
}

const MAX_USAGE = 5 * 1024 * 1024 * 1024; // 5 GB
const USAGE_WINDOW = 24 * 60 * 60 * 1000; // 24 hours

const hostToBucketMapping = {
    "v2.openaddresses.io": {
        "s3_bucket": "v2.openaddresses.io",
        "block_root": true,
    },
    "results.openaddresses.io": {
        "s3_bucket": "results.openaddresses.io",
        "index_file": "index.html",
        "cache_control": "public, max-age=604800, immutable",
    },
    "data.openaddresses.io": {
        "s3_bucket": "data.openaddresses.io",
        "block_root": true,
    }
}

const amzRedirectLocationHeaderName = "x-amz-website-redirect-location";

async function getUsage(env: Env, ip: string): Promise<number> {
    const usageData = await env.OA_USAGE.get(ip, { type: "json" }) as UsageData | null;
    if (!usageData) {
        return 0;
    }
    const { usage, timestamp } = usageData;
    const now = Date.now();
    if (now - timestamp > USAGE_WINDOW) {
        return 0;
    }
    return usage;
}

async function updateUsage(env: Env, ip: string, bytes: number): Promise<void> {
    const usageData = await env.OA_USAGE.get(ip, { type: "json" }) as UsageData | null;
    const now = Date.now();
    let newUsage = bytes;
    if (usageData) {
        const { usage, timestamp } = usageData;
        if (now - timestamp <= USAGE_WINDOW) {
            newUsage += usage;
        }
    }
    await env.OA_USAGE.put(ip, JSON.stringify({ usage: newUsage, timestamp: now }));
}

export default {
    async fetch(request: Request, env: Env, ctx: EventContext<any, any, any>): Promise<Response> {
        let cache = caches.default;
        const cacheUrl = new URL(request.url);
        const cacheKey = new Request(cacheUrl.toString(), request);
        let overallCacheResponse = await cache.match(cacheKey);
        if (overallCacheResponse) {
            console.log("Cache matched");
            return overallCacheResponse;
        }

        const ip = request.headers.get("CF-Connecting-IP");
        if (!ip) {
            return new Response("IP address not found", { status: 400 });
        }

        const url = new URL(request.url)
        const hostName = url.hostname;
        let s3objectName = url.pathname.slice(1);

        const config = hostToBucketMapping[hostName];
        if (!config) {
            let resp = new Response(`Unknown host`, {
                status: 404
            });
            ctx.waitUntil(cache.put(cacheKey, resp.clone()));
            return resp;
        }

        if (s3objectName == "" || s3objectName.endsWith("/")) {
            if (config.block_root) {
                const resp = new Response(`Bad Request`, {
                    status: 400
                });
                ctx.waitUntil(cache.put(cacheKey, resp.clone()));
                return resp;
            }

            if (config.index_file && (s3objectName == "" || s3objectName.endsWith("/"))) {
                s3objectName += config.index_file;
            }
        }

        const r2prefix = config.s3_bucket + "/";
        const r2objectName =  r2prefix + s3objectName;

        if (r2objectName === '') {
            const resp = new Response(`Bad Request`, {
                status: 400
            });
            ctx.waitUntil(cache.put(cacheKey, resp.clone()));
            return resp;
        }

        if (request.method !== 'GET') {
            const resp = new Response(`Method Not Allowed`, {
                status: 405
            });
            ctx.waitUntil(cache.put(cacheKey, resp.clone()));
            return resp;
        }

        const objHeadResp = await env.R2.head(r2objectName);

        if (objHeadResp === null) {
            const currentUsage = await getUsage(env, ip);
            if (currentUsage >= MAX_USAGE) {
                console.log(`Download limit exceeded for ${ip}`);
                return new Response("Download limit exceeded", { status: 429 });
            }

            console.log(`Fetching from S3: s3://${config.s3_bucket}/${s3objectName}`);

            const aws = new AwsClient({
                "accessKeyId": env.AWS_ACCESS_KEY_ID,
                "secretAccessKey": env.AWS_SECRET_ACCESS_KEY,
                "service": env.AWS_SERVICE,
                "region": env.AWS_DEFAULT_REGION
            });

            const requestToSign = new Request(`https://s3.us-east-1.amazonaws.com/${config.s3_bucket}/${s3objectName}`);
            // requestToSign.headers["host"] = `${config.s3_bucket}.s3.us-east-1.amazonaws.com`;
            const signedRequest = await aws.sign(requestToSign);
            const s3Object = await fetch(signedRequest);

            if (s3Object.status === 404) {
                const resp = new Response(`Object ${s3objectName} not found`, {
                    status: 404,
                });
                ctx.waitUntil(cache.put(cacheKey, resp.clone()));
                return resp;
            }

            let dataForR2, dataForResponse;

            const customMetadata = {};
            const redirectTo = s3Object.headers.get(amzRedirectLocationHeaderName);
            if (redirectTo) {
                customMetadata[amzRedirectLocationHeaderName] = redirectTo;
            }

            if (s3Object.headers.get("content-length") == null) {
                dataForR2 = await s3Object.text();
                dataForResponse = dataForR2;
            } else {
                const s3Body = s3Object.body.tee();
                dataForR2 = s3Body[0];
                dataForResponse = s3Body[1];

                // Track S3 data usage per IP address
                const contentLength = parseInt(s3Object.headers.get("content-length") || "0", 10);
                await updateUsage(env, ip, contentLength);
            }

            console.log(`Saving to R2: ${r2objectName}`);

            ctx.waitUntil(env.R2.put(r2objectName, dataForR2, {
                httpMetadata: s3Object.headers,
                customMetadata: customMetadata,
            }))

            if (redirectTo) {
                const resp = Response.redirect(redirectTo, 302);
                ctx.waitUntil(cache.put(cacheKey, resp.clone()));
                return resp;
            }

            // Clone the response so that it's no longer immutable
            const newResponse = new Response(dataForResponse, s3Object);
            if (config.cache_control) {
                newResponse.headers.set("cache-control", config.cache_control);
            }

            ctx.waitUntil(cache.put(cacheKey, newResponse.clone()));

            return newResponse;
        }

        if (objHeadResp.customMetadata[amzRedirectLocationHeaderName]) {
            const resp = Response.redirect(objHeadResp.customMetadata[amzRedirectLocationHeaderName], 302);
            ctx.waitUntil(cache.put(cacheKey, resp.clone()));
            return resp;
        }

        console.log(`Fetching from R2: ${r2objectName}`);

        const obj = await env.R2.get(r2objectName);

        const headers = new Headers()
        obj.writeHttpMetadata(headers)
        if (config.cache_control) {
            headers.set("cache-control", config.cache_control);
        }
        headers.set('etag', obj.httpEtag)
        const resp = new Response(obj.body, {
            headers
        });
        ctx.waitUntil(cache.put(cacheKey, resp.clone()));
        return resp;
    }
}
