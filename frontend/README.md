
# Multiplayer Pictionary

A real-time browser drawing-and-guessing game built with React, Vite,
Node.js, Express, and Socket.IO.

## Requirements

- Node.js 20 or newer
- npm 10 or newer

## Run the full app with one command

From the project root:

```bash
npm install
npm run dev
```

Open http://localhost:5173. The backend runs at http://localhost:5000.
Copy the room invite link to join from another browser or an incognito window.
At least two connected players are needed to start.

Build the frontend:

```bash
npm run build
```

## Features

- Create rooms and invite players by link or room code
- Host-controlled rounds, drawing time, word difficulty, and custom word lists
- Drawer chooses one of three words; only the drawer receives the secret word
- Real-time drawing with pen, color, brush size, eraser, fill, undo, and clear
- Server-side answer checking, scoring, hints, near-miss feedback, and turn timing
- Guess and drawing rate limits, coordinate validation, and answer-leak rejection
- Mid-round joining with drawing history
- Reconnect grace period of 30 seconds while the server process remains running
- End-of-game drawing replay

## Important limitation

The server stores state in memory. Restarting it clears active rooms, scores,
chat, drawings, and replay history. See TECHNICAL-NOTE.md.

## Three-player test / recording checklist

1. Run `npm install` and `npm run dev`.
2. Open http://localhost:5173 in three separate browser sessions.
3. Create a room in session 1; join from sessions 2 and 3.
4. Start the game, choose a word, draw, guess, and verify canvases match.
5. Try fill, undo, and clear.
6. Refresh a session within 30 seconds and verify reconnect behaviour.
7. Finish a game and use Replay all drawings.
8. Record a two-minute video showing the features working.

## Load test

Run:

```bash
npm run load-test
```

To test with 50 clients:

```bash
CLIENTS=50 npm run load-test
```

The script reports measurements from your machine. Do not claim a capacity
number until you have actually run and documented the test.
