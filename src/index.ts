import { AwsClient } from "aws4fetch";

interface Env {
    R2: R2Bucket,
    R2_OBJECT_PREFIX: string,
    AWS_ACCESS_KEY_ID: string,
    AWS_SECRET_ACCESS_KEY: string,
    AWS_SERVICE: string,
    AWS_DEFAULT_REGION: string,
    AWS_S3_BUCKET: string
    AWS_S3_BUCKET_SCHEME: string
}

const hostToBucketMapping = {
    "v2.openaddresses.io": {
        "s3_bucket": "v2.openaddresses.io",
    },
    "results.openaddresses.io": {
        "s3_bucket": "results.openaddresses.io",
        "index_file": "index.html",
        "cache_control": "public, max-age=604800, immutable",
    },
    "data.openaddresses.io": {
        "s3_bucket": "data.openaddresses.io",
    }
}

function objectNotFound(objectName: string): Response {
    return new Response(`Object ${objectName} not found`, {
        status: 404,
    })
}

const amzRedirectLocationHeaderName = "x-amz-website-redirect-location";
export default {
    async fetch(request: Request, env: Env, ctx: EventContext<any, any, any>): Promise<Response> {
        const url = new URL(request.url)
        const hostName = url.hostname;
        let s3objectName = url.pathname.slice(1);

        const config = hostToBucketMapping[hostName];
        if (!config) {
            return new Response(`Unknown host`, {
                status: 404
            })
        }

        if (config.index_file && s3objectName.endsWith("/")) {
            s3objectName += config.index_file;
        }

        const r2prefix = config.s3_bucket + "/";
        const r2objectName =  r2prefix + s3objectName;

        if (r2objectName === '') {
            return new Response(`Bad Request`, {
                status: 400
            })
        }

        if (request.method !== 'GET') {
            return new Response(`Method Not Allowed`, {
                status: 405
            })
        }

        const objHeadResp = await env.R2.head(r2objectName);

        if (objHeadResp === null) {
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
                return objectNotFound(s3objectName)
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
            }

            ctx.waitUntil(env.R2.put(r2objectName, dataForR2, {
                httpMetadata: s3Object.headers,
                customMetadata: customMetadata,
            }))

            if (redirectTo) {
                return Response.redirect(redirectTo, 302);
            }

            // Clone the response so that it's no longer immutable
            const newResponse = new Response(dataForResponse, s3Object);
            if (config.cache_control) {
                newResponse.headers.set("cache-control", config.cache_control);
            }

            return newResponse;
        }

        if (objHeadResp.customMetadata[amzRedirectLocationHeaderName]) {
            return Response.redirect(objHeadResp.customMetadata[amzRedirectLocationHeaderName], 302);
        }

        const obj = await env.R2.get(r2objectName);

        const headers = new Headers()
        obj.writeHttpMetadata(headers)
        if (config.cache_control) {
            headers.set("cache-control", config.cache_control);
        }
        headers.set('etag', obj.httpEtag)
        return new Response(obj.body, {
            headers
        });
    }
}
