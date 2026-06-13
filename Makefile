.PHONY: verify-a verify-b verify-c verify-d verify test

verify-a:
	bash verify/run_verify.sh a

verify-b:
	bash verify/run_verify.sh b

verify-c:
	bash verify/run_verify.sh c

verify-d:
	bash verify/run_verify.sh d

verify:
	bash verify/run_verify.sh all

test:
	daemon/.venv/bin/python -m pytest daemon/tests -q
