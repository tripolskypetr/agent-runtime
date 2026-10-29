# Compile TypeScript into ./build
build:
	npm run build

# Build and push the Docker image tripolskypetr/agent-runtime (expects `docker login`)
publish:
	npm run publish:x

# Run locally with variables from .env (copy .env.example first)
start:
	npm run build && npm start

# Run the end-to-end smoke test against BASE_URL (default http://localhost:8080)
smoke:
	npm run smoke
