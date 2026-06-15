# Run from anywhere: paths are resolved relative to this Makefile's location.
HERE := $(dir $(lastword $(MAKEFILE_LIST)))

.PHONY: verify-a verify-b verify-c verify-d verify test shot

verify-a:
	bash $(HERE)run_verify.sh a

verify-b:
	bash $(HERE)run_verify.sh b

verify-c:
	bash $(HERE)run_verify.sh c

verify-d:
	bash $(HERE)run_verify.sh d

verify:
	bash $(HERE)run_verify.sh all

test:
	cd $(HERE).. && uv run pytest -q

shot:
	bash $(HERE)shot.sh reconnect
	bash $(HERE)shot.sh screenshot
