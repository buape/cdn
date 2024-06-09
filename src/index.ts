import { Hono } from "hono";
import { nanoid } from "nanoid";
import { Path } from "@lifaon/path";
import { cache, auth, idLength, type Options } from "./utils";

const app = new Hono<Options>();

// cache on the browser for a year and cache on cloudflare for 2 hours
// https://developers.cloudflare.com/cache/about/cache-control#cache-control-directives
const cacheControl = "public, max-age=31536000, s-maxage=7200";

app.get("/", async (c) => {
    return c.redirect(c.env.REDIRECT_URL, 301);
});

app.get("/*", async (c) => {
    let key = c.req.path

    // remove first character from key
    if (key.startsWith("/")) key = key.slice(1);

    const object = await c.env.CDN_BUCKET.get(key);
    if (!object) return c.notFound();

    const data = await object.arrayBuffer();
    const contentType = object.httpMetadata?.contentType || "";

    return c.body(data, 200, {
        "Cache-Control": cacheControl,
        "Content-Type": contentType,
        ETag: object.httpEtag,
    });
});

app.post("/upload", auth(), async (c) => {
    const { media, slug } = await c.req.parseBody();

    if (!media) return c.notFound();

    if (!(media instanceof File)) {
        return c.json({ success: false, error: "Invalid media" }, 400);
    }

    const arrayBuffer = await media.arrayBuffer();

    let filename;
    if (slug) {
        filename = decodeURIComponent(slug as string);
    } else {
        filename = nanoid(idLength(c.req.header("Name-Length"), 8));
    }

    const { ext } = new Path(media.name).stemAndExtOrThrow();
    const fileWithExt = filename + ext;

    const url = new URL(c.req.url);
    url.pathname = "/" + fileWithExt;

    await c.env.CDN_BUCKET.put(fileWithExt, arrayBuffer, {
        httpMetadata: {
            contentType: media.type,
            cacheControl: cacheControl,
        },
        customMetadata: {
            "Upload-Url": url.toString(),
        },
    });

    return c.json({
        success: true,
        name: media.name,
        url: url.toString(),
    });
});

app.delete("/:key", auth(), async (c) => {
    const key = c.req.param("key");

    const object = await c.env.CDN_BUCKET.get(key);
    if (!object) {
        return c.json({ success: false, error: "File not found in the storage bucket, re-check the filename." }, 404);
    }

    await c.env.CDN_BUCKET.delete(key).catch((err) => {
        return c.json({ success: false, error: err.toString() }, 500);
    });

    return c.json({ success: true, name: `${key} has been deleted from the storage bucket, bear in mind that it may take a few minutes for the CDN to update.` });
});

app.onError((error, c) => {
    return c.json({ success: false, error: error.toString() }, 500);
});

app.notFound((c) => {
    return c.json(
        {
            success: false,
            error: "This resource can't be found, this is probably not your fault.",
        },
        404
    );
});

export default app;
