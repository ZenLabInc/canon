# CANON — an AI sandbox where discoveries become shared canon

[日本語](README.md)

CANON is a browser-game prototype in which AI adjudicates a combination of two materials once, then stores that discovery as permanent shared canon. Later players receive the same result from SQLite without another model call, so the world's rules accumulate as people play.

## Core loop

1. Break blocks and collect materials.
2. Press `E` and combine two items.
3. A previously unseen pair is adjudicated by Gemini and credited to its discoverer.
4. A known pair is reproduced from the database without an LLM call.
5. Recent first discoveries appear in the shared feed.

This is an early prototype. Authentication, moderation, multi-instance database coordination, migrations, and an operations console are not included.

## Local setup

Requires Node.js 22 or later and a Gemini API key with access to the configured models.

```sh
git clone https://github.com/ZenLabInc/canon.git
cd canon
npm install
cp .env.example .env
# Add GEMINI_API_KEY to .env
npm start
```

Open <http://localhost:3000>. Set `ENABLE_IMAGES=0` to disable generated item icons and reduce API usage. New item adjudication and image generation may incur Google API charges.

## Configuration

- `GEMINI_API_KEY`: required for previously unseen combinations
- `PORT`: HTTP port, default `3000`
- `DB_PATH`: SQLite file, default `./craft-cache.db`
- `ENABLE_IMAGES`: set to `0` to disable generated icons
- `MAX_NEW_PER_DAY`: global new-discovery cap per database file
- `RATE_PER_MIN`: in-memory new-discovery attempt cap per IP

The current SQLite design assumes one application process and persistent storage. In-memory rate limits are not shared across instances.

## API

- `POST /api/craft`: accepts two items and a display handle
- `GET /api/feed`: returns up to 15 recent discoveries

The pair key is order-independent. Stored records contain the result JSON, creation time, and discoverer handle.

## Docker

```sh
docker build -t canon .
docker run --rm -p 8080:8080 --env-file .env -v canon-data:/data canon
```

Provide API credentials through your hosting platform's secret store. Do not bake them into source code or the container image.

## License

No open-source license has been declared. Copyright remains with its owner unless separate permission is granted.
