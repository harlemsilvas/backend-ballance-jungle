#!/usr/bin/env bash
set -euo pipefail
awslocal sqs create-queue --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true
queue_arn=$(awslocal sqs get-queue-attributes --queue-url "$(awslocal sqs get-queue-url --queue-name wager-transactions-dlq.fifo --query QueueUrl --output text)" --attribute-names QueueArn --query Attributes.QueueArn --output text)
python3 - "$queue_arn" <<'ATTRS'
import json, sys
attrs = {"FifoQueue": "true", "VisibilityTimeout": "30", "RedrivePolicy": json.dumps({"deadLetterTargetArn": sys.argv[1], "maxReceiveCount": "5"})}
with open('/tmp/ballance-queue-attributes.json', 'w') as output:
    json.dump(attrs, output)
ATTRS
awslocal sqs create-queue --queue-name wager-transactions.fifo --attributes file:///tmp/ballance-queue-attributes.json
awslocal sqs create-queue --queue-name wager-events.fifo --attributes FifoQueue=true
