
import { useCallback, useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const SOCKET_URL =
  import.meta.env.VITE_SOCKET_URL || "http://localhost:5000";

const PLAYER_ID_KEY = "pictionary_player_id";
const SESSION_KEY = "pictionary_session";

const socket = io(SOCKET_URL, {
  autoConnect: false,
  reconnection: true,
});

const buttonStyle = {
  border: 0,
  borderRadius: 8,
  padding: "10px 14px",
  cursor: "pointer",
  fontWeight: 600,
};

const primaryButton = {
  ...buttonStyle,
  background: "#2563eb",
  color: "white",
};

const panelStyle = {
  background: "white",
  border: "1px solid #e2e8f0",
  borderRadius: 12,
  padding: 18,
  boxShadow: "0 3px 12px rgba(15,23,42,0.04)",
};

function getPlayerId() {
  let id = localStorage.getItem(PLAYER_ID_KEY);

  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, id);
  }

  return id;
}

function saveSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  localStorage.setItem(PLAYER_ID_KEY, session.playerId);
}

function getSavedSession() {
  try {
    const value = localStorage.getItem(SESSION_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function clearSavedSession() {
  localStorage.removeItem(SESSION_KEY);
}

function emitWithAck(event, payload = {}) {
  return new Promise((resolve) => {
    socket.timeout(5000).emit(event, payload, (error, response) => {
      if (error) {
        resolve({
          success: false,
          message: "Server did not respond. Please try again.",
        });
      } else {
        resolve(
          response || {
            success: false,
            message: "No response from server.",
          }
        );
      }
    });
  });
}

export default function App() {
  const [name, setName] = useState("");
  const [roomIdInput, setRoomIdInput] = useState("");
  const [playerId, setPlayerId] = useState(() => getPlayerId());
  const [room, setRoom] = useState(null);
  const [secretWord, setSecretWord] = useState("");
  const [guess, setGuess] = useState("");
  const [messages, setMessages] = useState([]);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(socket.connected);
  const [settings, setSettings] = useState({
    rounds: 3,
    drawTime: 60,
    words: "normal",
  });

  const isDrawer = room?.game?.drawerId === playerId;
  const isDrawing = room?.status === "drawing";
  const hasGuessed =
    room?.game?.guessedPlayerIds?.includes(playerId) || false;
  const drawer = room?.players?.find(
    (player) => player.id === room?.game?.drawerId
  );
  const isHost = room?.hostId === playerId;

  const addSystemMessage = useCallback((text) => {
    setMessages((previous) =>
      [
        ...previous,
        {
          id: crypto.randomUUID(),
          type: "system",
          playerName: "Game",
          text,
          createdAt: new Date().toISOString(),
        },
      ].slice(-100)
    );
  }, []);

  useEffect(() => {
    function onConnect() {
      setConnected(true);

      const saved = getSavedSession();
      if (!saved?.roomId || !saved?.playerId) return;

      socket.emit(
        "room:reconnect",
        {
          roomId: saved.roomId,
          playerId: saved.playerId,
        },
        (response) => {
          if (response?.success) {
            setPlayerId(response.playerId);
            setName(saved.name || "");
            setRoom(response.state);
            setSettings(response.state?.settings || {
              rounds: 3,
              drawTime: 60,
              words: "normal",
            });
            setError("");
            setNotice("Reconnected! Your game state has been restored.");
          } else {
            clearSavedSession();
            setNotice("");
            setError(response?.message || "Your previous session has expired.");
          }
        }
      );
    }

    function onDisconnect() {
      setConnected(false);
      if (getSavedSession()) {
        setNotice("Connection lost. Trying to reconnect…");
      }
    }

    function onConnectError() {
      setConnected(false);
      setError("Cannot connect to the server. Check that the backend is running.");
    }

    function onRoomState(state) {
      setRoom(state);
      if (state?.settings) setSettings(state.settings);
    }

    function onPrivateState(state) {
      setSecretWord(state?.secretWord || "");
    }

    function onStarted(data) {
      setSecretWord("");
      setGuess("");
      setNotice(
        `${data.drawerName} is drawing. Round ${data.round} of ${data.totalRounds}.`
      );
    }

    function onTurnEnded(data) {
      setSecretWord("");
      setGuess("");
      setNotice(`Turn ended. The word was "${data.answer}".`);
      addSystemMessage(`Turn ended — the word was "${data.answer}".`);
    }

    function onNotice(data) {
      setNotice(data?.message || "");
    }

    function onFinished(data) {
      setSecretWord("");
      const winner = data?.scoreboard?.[0];
      setNotice(
        winner ? `Game finished! Winner: ${winner.name}` : "Game finished!"
      );
    }

    function onChatMessage(message) {
      setMessages((previous) => [...previous, message].slice(-100));
    }

    function onChatHistory(history) {
      setMessages(Array.isArray(history) ? history : []);
    }

    function onCorrectGuess(data) {
      addSystemMessage(
        `${data.playerName} guessed correctly (+${data.points} points). ` +
          `${data.drawerName} earns ${data.drawerPoints} points.`
      );
    }

    function onHint(data) {
      if (data?.hintPattern) {
        setNotice(`Hint: ${data.hintPattern}`);
      }
    }

    function onCloseGuess(data) {
      setNotice(data?.message || "Close!");
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("room:state", onRoomState);
    socket.on("game:state", onRoomState);
    socket.on("game:private-state", onPrivateState);
    socket.on("game:started", onStarted);
    socket.on("game:turn-ended", onTurnEnded);
    socket.on("game:notice", onNotice);
    socket.on("game:finished", onFinished);
    socket.on("game:hint", onHint);
    socket.on("game:close-guess", onCloseGuess);
    socket.on("chat:message", onChatMessage);
    socket.on("chat:history", onChatHistory);
    socket.on("guess:correct", onCorrectGuess);

    if (!socket.connected) socket.connect();

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("room:state", onRoomState);
      socket.off("game:state", onRoomState);
      socket.off("game:private-state", onPrivateState);
      socket.off("game:started", onStarted);
      socket.off("game:turn-ended", onTurnEnded);
      socket.off("game:notice", onNotice);
      socket.off("game:finished", onFinished);
      socket.off("game:hint", onHint);
      socket.off("game:close-guess", onCloseGuess);
      socket.off("chat:message", onChatMessage);
      socket.off("chat:history", onChatHistory);
      socket.off("guess:correct", onCorrectGuess);
    };
  }, [addSystemMessage]);

  async function enterRoom(action) {
    setError("");
    setNotice("");

    const cleanName = name.trim();

    if (!cleanName) {
      setError("Please enter your name.");
      return;
    }

    if (action === "join" && !roomIdInput.trim()) {
      setError("Please enter a room code.");
      return;
    }

    if (!socket.connected) socket.connect();

    const connectedOk = await new Promise((resolve) => {
      if (socket.connected) return resolve(true);

      const timeout = setTimeout(() => resolve(false), 5000);
      socket.once("connect", () => {
        clearTimeout(timeout);
        resolve(true);
      });
      socket.once("connect_error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });

    if (!connectedOk) {
      setError("Cannot connect to the server. Check that the backend is running.");
      return;
    }

    const id = getPlayerId();
    setPlayerId(id);

    const payload =
      action === "create"
        ? { name: cleanName, playerId: id }
        : {
            name: cleanName,
            playerId: id,
            roomId: roomIdInput.trim().toUpperCase(),
          };

    const response = await emitWithAck(
      action === "create" ? "room:create" : "room:join",
      payload
    );

    if (!response?.success) {
      setError(response?.message || "Could not enter the room.");
      return;
    }

    const session = {
      roomId: response.roomId,
      playerId: response.playerId || id,
      name: cleanName,
    };

    saveSession(session);
    setPlayerId(session.playerId);
    setRoom(response.state);
    setMessages([]);
    setSecretWord("");
    setNotice(
      action === "create"
        ? "Room created. Share the room code with a friend."
        : "Joined room."
    );

    socket.emit("room:get-state", {}, () => {});
  }

  async function updateSettings() {
    const response = await emitWithAck("room:update-settings", settings);

    if (!response?.success) {
      setError(response?.message || "Could not update settings.");
    } else {
      setNotice("Game settings updated.");
    }
  }

  async function startGame() {
    setError("");
    const response = await emitWithAck("game:start");

    if (!response?.success) {
      setError(response?.message || "Could not start the game.");
    }
  }

  async function submitGuess(event) {
    event.preventDefault();

    const value = guess.trim();
    if (!value || !isDrawing || isDrawer || hasGuessed) return;

    const response = await emitWithAck("game:guess", { guess: value });

    if (!response?.success) {
      setError(response?.message || "Could not submit guess.");
      return;
    }

    setError("");
    setGuess("");

    if (response.correct) {
      setNotice(`Correct! You earned ${response.points} points.`);
    }
  }

  async function leaveRoom() {
    await emitWithAck("room:leave");
    clearSavedSession();
    socket.disconnect();

    setRoom(null);
    setSecretWord("");
    setMessages([]);
    setNotice("");
    setError("");
    setRoomIdInput("");
  }

  async function copyInvite() {
    const invite = `${window.location.origin}?room=${room?.roomId || ""}`;

    try {
      await navigator.clipboard.writeText(invite);
      setNotice("Invite link copied.");
    } catch {
      setNotice(`Share room code: ${room?.roomId}`);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const invitedRoom = params.get("room");
    if (invitedRoom) setRoomIdInput(invitedRoom.toUpperCase());
  }, []);

  if (!room) {
    return (
      <main style={styles.page}>
        <section style={{ ...panelStyle, maxWidth: 520, width: "100%" }}>
          <h1 style={{ marginTop: 0 }}>🎨 Multiplayer Pictionary</h1>
          <p style={{ color: "#64748b" }}>
            Create a room or join a friend to draw, guess, and earn points.
          </p>

          <label style={styles.label}>Your name</label>
          <input
            style={styles.input}
            value={name}
            maxLength={24}
            onChange={(event) => setName(event.target.value)}
            placeholder="Enter your name"
          />

          <button
            style={{ ...primaryButton, width: "100%", marginTop: 14 }}
            onClick={() => enterRoom("create")}
          >
            Create Room
          </button>

          <div style={styles.separator}>
            <span>OR JOIN A ROOM</span>
          </div>

          <label style={styles.label}>Room code</label>
          <input
            style={styles.input}
            value={roomIdInput}
            maxLength={6}
            onChange={(event) =>
              setRoomIdInput(event.target.value.toUpperCase())
            }
            placeholder="e.g. A2BCDE"
          />

          <button
            style={{
              ...buttonStyle,
              width: "100%",
              marginTop: 10,
              background: "#0f172a",
              color: "white",
            }}
            onClick={() => enterRoom("join")}
          >
            Join Room
          </button>

          <p
            style={{
              fontSize: 13,
              color: connected ? "#15803d" : "#64748b",
              marginBottom: 0,
            }}
          >
            {connected ? "Connected to server" : "Connecting to server…"}
          </p>

          {notice && <p style={styles.notice}>{notice}</p>}
          {error && <p style={styles.error}>{error}</p>}
        </section>
      </main>
    );
  }

  const sortedPlayers = [...room.players].sort((a, b) => b.score - a.score);

  return (
    <main style={styles.page}>
      <header style={styles.header}>
        <div>
          <h1 style={{ margin: 0 }}>🎨 Pictionary</h1>
          <div style={{ color: "#64748b", fontSize: 14, marginTop: 5 }}>
            Room code: <strong>{room.roomId}</strong>
            {" · "}Round {room.game.round}/{room.game.totalRounds}
          </div>
          <div
            style={{
              fontSize: 12,
              marginTop: 5,
              color: connected ? "#15803d" : "#b45309",
            }}
          >
            {connected
              ? "● Connected"
              : "● Connection lost — attempting to reconnect"}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button style={buttonStyle} onClick={copyInvite}>
            Copy Invite
          </button>
          <button
            style={{
              ...buttonStyle,
              background: "#fee2e2",
              color: "#991b1b",
            }}
            onClick={leaveRoom}
          >
            Leave Room
          </button>
        </div>
      </header>

      {notice && <div style={styles.notice}>{notice}</div>}
      {error && <div style={styles.error}>{error}</div>}

      <div style={styles.layout}>
        <section style={panelStyle}>
          <div style={styles.gameHeader}>
            <div>
              <div style={styles.smallHeading}>CURRENT DRAWER</div>
              <strong>{drawer?.name || "Waiting for game"}</strong>
              {drawer && !drawer.connected && (
                <div style={styles.subText}>Reconnecting…</div>
              )}
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={styles.smallHeading}>TIME LEFT</div>
              <strong style={{ fontSize: 24 }}>{room.game.timeLeft}s</strong>
            </div>
          </div>

          {isDrawer && isDrawing && (
            <div style={styles.wordBox}>
              Your word: <strong>{secretWord || "Choosing word…"}</strong>
            </div>
          )}

          {isDrawing && !isDrawer && (
            <div style={styles.wordBox}>
              Guess the word!
              {hasGuessed
                ? " You already guessed correctly."
                : ` Hint: ${room.game.hintPattern || "Waiting for a hint…"}`}
              <div style={{ fontSize: 12, marginTop: 5 }}>
                Letters revealed: {room.game.hintsRevealed || 0}
              </div>
            </div>
          )}

          {isDrawing ? (
            <DrawingCanvas
              key={room.roomId}
              socket={socket}
              canDraw={isDrawer && connected}
            />
          ) : (
            <div style={styles.waiting}>
              {room.status === "finished"
                ? "Game finished! Check the scoreboard."
                : "Waiting for the host to start the game…"}
            </div>
          )}

          {isHost && room.status === "waiting" && (
            <div
              style={{
                marginTop: 20,
                borderTop: "1px solid #e2e8f0",
                paddingTop: 18,
              }}
            >
              <h3 style={{ marginTop: 0 }}>Game Settings</h3>

              <div style={styles.settingsGrid}>
                <label style={styles.label}>
                  Rounds
                  <select
                    style={styles.input}
                    value={settings.rounds}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        rounds: Number(event.target.value),
                      })
                    }
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>

                <label style={styles.label}>
                  Draw time
                  <select
                    style={styles.input}
                    value={settings.drawTime}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        drawTime: Number(event.target.value),
                      })
                    }
                  >
                    {[30, 45, 60, 90, 120, 180].map((value) => (
                      <option key={value} value={value}>
                        {value} seconds
                      </option>
                    ))}
                  </select>
                </label>

                <label style={styles.label}>
                  Word difficulty
                  <select
                    style={styles.input}
                    value={settings.words}
                    onChange={(event) =>
                      setSettings({ ...settings, words: event.target.value })
                    }
                  >
                    <option value="easy">Easy</option>
                    <option value="normal">Normal</option>
                    <option value="hard">Hard</option>
                  </select>
                </label>
              </div>

              <div
                style={{
                  display: "flex",
                  gap: 8,
                  marginTop: 12,
                  flexWrap: "wrap",
                }}
              >
                <button style={buttonStyle} onClick={updateSettings}>
                  Save Settings
                </button>
                <button style={primaryButton} onClick={startGame}>
                  Start Game
                </button>
              </div>
            </div>
          )}
        </section>

        <aside style={{ display: "grid", gap: 16, alignContent: "start" }}>
          <section style={panelStyle}>
            <h3 style={{ marginTop: 0 }}>
              Players ({room.players.length})
            </h3>

            {sortedPlayers.map((player, index) => (
              <div key={player.id} style={styles.playerRow}>
                <div>
                  <strong>
                    {index + 1}. {player.name}
                  </strong>
                  {player.id === playerId && (
                    <span style={styles.youTag}>YOU</span>
                  )}
                  {player.isHost && <span style={styles.hostTag}>HOST</span>}

                  {player.id === room.game.drawerId && (
                    <div style={styles.subText}>✏️ Drawing</div>
                  )}

                  {!player.connected && (
                    <div style={{ ...styles.subText, color: "#b45309" }}>
                      Connection lost · 30-second grace period
                    </div>
                  )}

                  {room.game.guessedPlayerIds?.includes(player.id) && (
                    <div style={styles.subText}>✓ Guessed correctly</div>
                  )}
                </div>

                <strong>{player.score}</strong>
              </div>
            ))}
          </section>

          <section
            style={{
              ...panelStyle,
              minHeight: 300,
              display: "flex",
              flexDirection: "column",
            }}
          >
            <h3 style={{ marginTop: 0, marginBottom: 10 }}>Guesses & Chat</h3>

            <div style={styles.chatMessages}>
              {messages.length === 0 && (
                <p style={{ color: "#94a3b8", fontSize: 14 }}>
                  Messages will appear here.
                </p>
              )}

              {messages.map((message) => (
                <div
                  key={message.id}
                  style={{
                    ...styles.chatMessage,
                    background:
                      message.type === "system" ? "#eff6ff" : "#f8fafc",
                  }}
                >
                  {message.type !== "system" && (
                    <strong style={{ display: "block", fontSize: 12 }}>
                      {message.playerName}
                    </strong>
                  )}
                  <span>{message.text}</span>
                </div>
              ))}
            </div>

            <form
              onSubmit={submitGuess}
              style={{ display: "flex", gap: 8, marginTop: 10 }}
            >
              <input
                style={{ ...styles.input, flex: 1, minWidth: 0 }}
                value={guess}
                onChange={(event) => setGuess(event.target.value)}
                placeholder={
                  !isDrawing
                    ? "Game is not active"
                    : isDrawer
                      ? "You are drawing"
                      : hasGuessed
                        ? "Correct guess submitted"
                        : "Type your guess…"
                }
                maxLength={100}
                disabled={!isDrawing || isDrawer || hasGuessed || !connected}
              />

              <button
                type="submit"
                style={primaryButton}
                disabled={
                  !isDrawing ||
                  isDrawer ||
                  hasGuessed ||
                  !guess.trim() ||
                  !connected
                }
              >
                Guess
              </button>
            </form>

            {isDrawer && isDrawing && (
              <p style={{ fontSize: 12, color: "#64748b", marginBottom: 0 }}>
                You are the drawer, so you cannot submit guesses this turn.
              </p>
            )}
          </section>
        </aside>
      </div>

      {room.status === "finished" && (
        <section style={{ ...panelStyle, marginTop: 18 }}>
          <h2 style={{ marginTop: 0 }}>🏆 Final Scoreboard</h2>
          {sortedPlayers.map((player, index) => (
            <div key={player.id} style={styles.playerRow}>
              <span>
                {index === 0 ? "🥇" : `${index + 1}.`} {player.name}
              </span>
              <strong>{player.score} points</strong>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}

function DrawingCanvas({ socket, canDraw }) {
  const canvasRef = useRef(null);
  const drawingRef = useRef(false);
  const previousPointRef = useRef(null);
  const currentStrokeIdRef = useRef(null);
  const strokesRef = useRef([]);

  const [color, setColor] = useState("#111827");
  const [size, setSize] = useState(4);
  const [tool, setTool] = useState("pen");

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const stroke of strokesRef.current) {
      drawStroke(ctx, stroke, canvas);
    }
  }, []);

  useEffect(() => {
    function onStroke(stroke) {
      const alreadyExists = strokesRef.current.some(
        (existing) =>
          existing.segmentId &&
          stroke.segmentId &&
          existing.segmentId === stroke.segmentId
      );

      if (!alreadyExists) {
        strokesRef.current.push(stroke);
        redraw();
      }
    }

    function onHistory(history) {
      strokesRef.current = Array.isArray(history) ? history : [];
      redraw();
    }

    function onUndo(data) {
      const strokeId = typeof data === "string" ? data : data?.strokeId;

      if (strokeId) {
        strokesRef.current = strokesRef.current.filter(
          (stroke) => stroke.strokeId !== strokeId
        );
      } else {
        strokesRef.current.pop();
      }

      redraw();
    }

    function onClear() {
      strokesRef.current = [];
      redraw();
    }

    socket.on("drawing:stroke", onStroke);
    socket.on("drawing:history", onHistory);
    socket.on("drawing:undo", onUndo);
    socket.on("drawing:cleared", onClear);

    socket.emit("drawing:request-history", {}, () => {});

    return () => {
      socket.off("drawing:stroke", onStroke);
      socket.off("drawing:history", onHistory);
      socket.off("drawing:undo", onUndo);
      socket.off("drawing:cleared", onClear);
    };
  }, [socket, redraw]);

  function getPoint(event) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();

    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }

  function sendPoint(point, start) {
    const stroke = {
      strokeId: currentStrokeIdRef.current,
      segmentId: crypto.randomUUID(),
      start,
      point,
      color: tool === "eraser" ? "#ffffff" : color,
      size: tool === "eraser" ? Math.max(size, 18) : size,
      tool,
    };

    strokesRef.current.push(stroke);
    redraw();
    socket.emit("drawing:stroke", stroke);
  }

  function pointerDown(event) {
    if (!canDraw) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    drawingRef.current = true;
    currentStrokeIdRef.current = crypto.randomUUID();

    const point = getPoint(event);
    previousPointRef.current = point;
    sendPoint(point, point);
  }

  function pointerMove(event) {
    if (!canDraw || !drawingRef.current) return;

    const point = getPoint(event);
    sendPoint(point, previousPointRef.current);
    previousPointRef.current = point;
  }

  function pointerUp() {
    drawingRef.current = false;
    previousPointRef.current = null;
    currentStrokeIdRef.current = null;
  }

  function undo() {
    if (canDraw) socket.emit("drawing:undo", {});
  }

  function clearCanvas() {
    if (canDraw) socket.emit("drawing:clear", {});
  }

  return (
    <div>
      {canDraw && (
        <div style={styles.toolbar}>
          <label style={styles.toolbarLabel}>
            Color
            <input
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
            />
          </label>

          <label style={styles.toolbarLabel}>
            Brush
            <input
              type="range"
              min="2"
              max="20"
              value={size}
              onChange={(event) => setSize(Number(event.target.value))}
            />
            {size}
          </label>

          <button
            style={buttonStyle}
            onClick={() =>
              setTool((current) => (current === "pen" ? "eraser" : "pen"))
            }
          >
            {tool === "pen" ? "Eraser" : "Pen"}
          </button>

          <button style={buttonStyle} onClick={undo}>
            Undo
          </button>

          <button style={buttonStyle} onClick={clearCanvas}>
            Clear
          </button>
        </div>
      )}

      <canvas
        ref={canvasRef}
        width={900}
        height={500}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onPointerLeave={pointerUp}
        style={{
          display: "block",
          width: "100%",
          height: "auto",
          aspectRatio: "9 / 5",
          border: "1px solid #cbd5e1",
          borderRadius: 8,
          background: "white",
          touchAction: "none",
          cursor: canDraw ? "crosshair" : "default",
        }}
      />

      {!canDraw && (
        <p style={{ color: "#64748b", fontSize: 13, marginBottom: 0 }}>
          Watch the drawing and submit your guess in the chat.
        </p>
      )}
    </div>
  );
}

function drawStroke(ctx, stroke, canvas) {
  const start = stroke.start || stroke.point;
  const end = stroke.point;

  if (!start || !end) return;

  ctx.save();
  ctx.strokeStyle = stroke.color || "#111827";
  ctx.fillStyle = stroke.color || "#111827";
  ctx.lineWidth = stroke.size || 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  const x1 = start.x * canvas.width;
  const y1 = start.y * canvas.height;
  const x2 = end.x * canvas.width;
  const y2 = end.y * canvas.height;

  if (x1 === x2 && y1 === y2) {
    ctx.beginPath();
    ctx.arc(x1, y1, (stroke.size || 4) / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  }

  ctx.restore();
}

const styles = {
  page: {
    minHeight: "100vh",
    background: "#f1f5f9",
    color: "#0f172a",
    padding: 24,
    fontFamily:
      "Inter, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
    boxSizing: "border-box",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    flexWrap: "wrap",
    maxWidth: 1500,
    margin: "0 auto 20px",
  },
  layout: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 2fr) minmax(280px, 1fr)",
    gap: 18,
    maxWidth: 1500,
    margin: "0 auto",
    alignItems: "start",
  },
  label: {
    display: "block",
    fontSize: 13,
    fontWeight: 600,
    marginBottom: 8,
    color: "#334155",
  },
  input: {
    display: "block",
    boxSizing: "border-box",
    width: "100%",
    border: "1px solid #cbd5e1",
    borderRadius: 8,
    padding: "10px 12px",
    background: "white",
    color: "#0f172a",
    marginTop: 6,
  },
  error: {
    background: "#fee2e2",
    color: "#991b1b",
    padding: 12,
    borderRadius: 8,
    marginTop: 12,
  },
  notice: {
    maxWidth: 1500,
    margin: "0 auto 16px",
    background: "#dbeafe",
    color: "#1d4ed8",
    padding: 12,
    borderRadius: 8,
  },
  gameHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    marginBottom: 14,
  },
  smallHeading: {
    fontSize: 13,
    color: "#64748b",
  },
  wordBox: {
    background: "#fef3c7",
    color: "#92400e",
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
  },
  waiting: {
    display: "grid",
    placeItems: "center",
    minHeight: 300,
    background: "#f8fafc",
    border: "1px dashed #cbd5e1",
    borderRadius: 8,
    color: "#64748b",
  },
  settingsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
    gap: 12,
  },
  playerRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    padding: "12px 0",
    borderBottom: "1px solid #f1f5f9",
  },
  youTag: {
    fontSize: 10,
    marginLeft: 6,
    background: "#dbeafe",
    color: "#1d4ed8",
    padding: "3px 5px",
    borderRadius: 4,
  },
  hostTag: {
    fontSize: 10,
    marginLeft: 6,
    background: "#fef3c7",
    color: "#92400e",
    padding: "3px 5px",
    borderRadius: 4,
  },
  subText: {
    fontSize: 12,
    color: "#64748b",
    marginTop: 4,
  },
  chatMessages: {
    flex: 1,
    minHeight: 150,
    maxHeight: 320,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  chatMessage: {
    padding: 9,
    borderRadius: 8,
    overflowWrap: "anywhere",
    fontSize: 14,
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    marginBottom: 12,
  },
  toolbarLabel: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13,
  },
  separator: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    margin: "20px 0",
    color: "#94a3b8",
    fontSize: 12,
  },
};
