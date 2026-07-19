# Hosted child fixture

This immutable fixture is uploaded as the only source root for the local POC.
The owner writes its state, the hosted child changes the result files, and the
owner applies the durable child patch before running `verify.sh`.
