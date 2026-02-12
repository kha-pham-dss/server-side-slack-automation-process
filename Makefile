# Deploy serverless stack (SAM) to AWS
# Run from repo root: make deploy

IAM_DIR := iac

.PHONY: build deploy

build:
	cd $(IAM_DIR) && sam build

deploy: build
	cd $(IAM_DIR) && sam deploy
