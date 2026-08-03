# SAM Makefile build — SHARED_SRC luôn trỏ serverless/shared (không phụ thuộc cwd)
SHARED_SRC := $(dir $(abspath $(lastword $(MAKEFILE_LIST))))../shared

build-EnsureMonthSheetFunction:
	cp package.json package-lock.json index.js $(ARTIFACTS_DIR)/
	cd $(ARTIFACTS_DIR) && npm ci --omit=dev
	mkdir -p $(ARTIFACTS_DIR)/node_modules/@slack-dishes
	rm -rf $(ARTIFACTS_DIR)/node_modules/@slack-dishes/shared
	cp -r $(SHARED_SRC) $(ARTIFACTS_DIR)/node_modules/@slack-dishes/shared
