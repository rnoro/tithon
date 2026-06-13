.PHONY: verify-a verify-b verify test

verify-a:
	bash verify/run_verify.sh a

verify-b:
	bash verify/run_verify.sh b

verify:
	bash verify/run_verify.sh all

test:
	daemon/.venv/bin/python -m pytest daemon/tests -q
