
# Technical note

## Canvas synchronization

The drawer sends normalized coordinates from 0 to 1 through Socket.IO.
Each drawing gesture has a strokeId, and each segment has a segmentId.
The backend validates drawer permissions, coordinate ranges, tool names,
and brush-size bounds before storing and broadcasting a segment.

A joining or reconnecting client receives the current drawing history.
Undo removes the segments associated with the most recent gesture.
Fill operations are represented in the ordered drawing history.

## Latency and event ordering

Socket.IO preserves event ordering for each connection. The drawer renders
strokes locally for responsiveness, while the server broadcasts validated
segments to the other clients. The UI countdown uses the server-provided
endsAt timestamp.

Remote clients may receive strokes later than the drawer because of network
latency. The drawing-history event allows a joining or reconnecting client
to reconstruct the current canvas.

## Server restart and persistence

Room state, scores, chat, drawing history, and replay are stored in process
memory. Restarting the server loses active games. The reconnect grace period
only works while the server process remains alive.

For a production deployment, persist durable game state in PostgreSQL or
another database and consider Redis plus a Socket.IO adapter for coordinating
multiple backend instances.

## Capacity estimate and measurement

The room limit is eight players. No fixed concurrent-room capacity is claimed
without measurement.

Run `npm run load-test`, starting with CLIENTS=20 and increasing gradually.
Monitor CPU, RSS memory, event latency, and network traffic. Record machine
specifications, client count, room count, test duration, and p95/p99 event
latency before reporting a capacity figure. The included script is a smoke
test, not a benchmark result.
