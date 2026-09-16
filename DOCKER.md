# Docker

Run Mmomarket in a container.

---

## Quick start

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.mmomarket:/app/data" \
  -e DATA_DIR=/app/data \
  --name mmomarket \
  decolua/mmomarket:latest
```

App listens on port `20128`. Open: http://localhost:20128

## Manage container

```bash
docker logs -f mmomarket        # view logs
docker stop mmomarket           # stop
docker start mmomarket          # start again
docker rm -f mmomarket          # remove
```

## Data persistence

```bash
-v "$HOME/.mmomarket:/app/data" \
-e DATA_DIR=/app/data
```

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
└── ...                   # certs, logs, runtime configs
```

## Optional env vars

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.mmomarket:/app/data" \
  -e DATA_DIR=/app/data \
  -e PORT=20128 \
  -e HOSTNAME=0.0.0.0 \
  -e DEBUG=true \
  --name mmomarket \
  decolua/mmomarket:latest
```

## Update to latest

```bash
docker pull decolua/mmomarket:latest
docker rm -f mmomarket
# re-run the quick start command
```

---

## Build image locally (dev)

```bash
docker build -t mmomarket .

docker run --rm -p 20128:20128 \
  -v "$HOME/.mmomarket:/app/data" \
  -e DATA_DIR=/app/data \
  mmomarket
```
