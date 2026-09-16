docker stop mmomarket
docker rm mmomarket
docker build -t mmomarket .
docker run -d --name mmomarket -p 20128:20128 --env-file .env -v mmomarket-data:/app/data mmomarket