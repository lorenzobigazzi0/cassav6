# Reliability model

```text
link delivery: at least once
local durable message: retained until final ACK policy
frame duplicate: ignored
message duplicate: ACK repeated, no re-delivery to upper layer
connection loss: session closes, outbox retained
```
