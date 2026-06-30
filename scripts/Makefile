# Run from anywhere: paths are resolved relative to this Makefile's location.
# Run a focused topic bundle while developing that area, or a meta-bundle.
#   make fast            # every hermetic test (no VSCode) — the quick gate
#   make restore         # just the reconnect/restore tests, etc.
#   make vscode          # every real-VSCode test (network + xvfb; one shared build)
#   make all             # fast + vscode
# Topic bundles: core serializer backpressure widgets restore livesync kernels
#                richoutputs notebook  (see run_verify.sh for membership).
HERE := $(dir $(lastword $(MAKEFILE_LIST)))

BUNDLES := core serializer backpressure widgets restore livesync kernels \
           richoutputs notebook fast vscode all

.PHONY: $(BUNDLES) verify test shot

$(BUNDLES):
	bash $(HERE)run_verify.sh $@

verify: fast        # convenience alias: the quick hermetic gate

test:
	cd $(HERE).. && uv run pytest -q

shot:
	bash $(HERE)shot.sh reconnect
	bash $(HERE)shot.sh screenshot
