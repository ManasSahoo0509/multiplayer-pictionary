
import { useCallback, useEffect, useRef, useState } from "react";

const CANVAS_WIDTH = 900;
const CANVAS_HEIGHT = 520;

function DrawingCanvas({ socket, room, canDraw = true }) {
  const canvasRef = useRef(null);
  const activeStrokeRef = useRef(null);
  const strokesRef = useRef([]);

  const [color, setColor] = useState("#20243a");
  const [size, setSize] = useState(5);
  const [tool, setTool] = useState("pen");

  const drawStroke = useCallback((ctx, stroke) => {
    if (!stroke?.points?.length) return;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle =
      stroke.tool === "eraser" ? "#ffffff" : stroke.color;
    ctx.lineWidth = stroke.size;

    const points = stroke.points;

    ctx.beginPath();
    ctx.moveTo(
      points[0].x * CANVAS_WIDTH,
      points[0].y * CANVAS_HEIGHT
    );

    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(
        points[i].x * CANVAS_WIDTH,
        points[i].y * CANVAS_HEIGHT
      );
    }

    if (points.length === 1) {
      ctx.lineTo(
        points[0].x * CANVAS_WIDTH + 0.1,
        points[0].y * CANVAS_HEIGHT + 0.1
      );
    }

    ctx.stroke();
    ctx.restore();
  }, []);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");

    ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    for (const stroke of strokesRef.current) {
      drawStroke(ctx, stroke);
    }
  }, [drawStroke]);

  useEffect(() => {
    function handleRemoteStroke(event) {
      if (event.start) {
        const newStroke = {
          ...event,
          points: [...event.points],
        };

        strokesRef.current.push(newStroke);
        drawStroke(canvasRef.current?.getContext("2d"), newStroke);
        return;
      }

      const existingStroke = strokesRef.current.find(
        (stroke) => stroke.strokeId === event.strokeId
      );

      if (!existingStroke) return;

      const previous =
        existingStroke.points[existingStroke.points.length - 1];
      const point = event.points[event.points.length - 1];

      existingStroke.points.push(point);

      drawStroke(canvasRef.current?.getContext("2d"), {
        ...event,
        points: [previous, point],
      });
    }

    function handleDrawingHistory(history) {
      strokesRef.current = Array.isArray(history)
        ? history.map((stroke) => ({
            ...stroke,
            points: [...stroke.points],
          }))
        : [];

      activeStrokeRef.current = null;
      redraw();
    }

    socket.on("drawing:stroke", handleRemoteStroke);
    socket.on("drawing:history", handleDrawingHistory);

    // Get the existing drawing when this component mounts.
    socket.emit("drawing:request-history");

    return () => {
      socket.off("drawing:stroke", handleRemoteStroke);
      socket.off("drawing:history", handleDrawingHistory);
    };
  }, [socket, drawStroke, redraw, room?.roomId]);

  function getPoint(event) {
    const rect = canvasRef.current.getBoundingClientRect();

    return {
      x: Math.max(
        0,
        Math.min(1, (event.clientX - rect.left) / rect.width)
      ),
      y: Math.max(
        0,
        Math.min(1, (event.clientY - rect.top) / rect.height)
      ),
    };
  }

  function startDrawing(event) {
    if (!canDraw || !room) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const stroke = {
      strokeId: `${socket.id}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}`,
      points: [getPoint(event)],
      color,
      size,
      tool,
    };

    activeStrokeRef.current = stroke;
    strokesRef.current.push(stroke);

    drawStroke(canvasRef.current.getContext("2d"), stroke);

    socket.emit("drawing:stroke", {
      ...stroke,
      start: true,
    });
  }

  function continueDrawing(event) {
    const stroke = activeStrokeRef.current;
    if (!stroke || !canDraw) return;

    event.preventDefault();

    const point = getPoint(event);
    const points = stroke.points;
    const previous = points[points.length - 1];

    if (
      Math.abs(point.x - previous.x) < 0.001 &&
      Math.abs(point.y - previous.y) < 0.001
    ) {
      return;
    }

    points.push(point);

    const segment = {
      strokeId: stroke.strokeId,
      points: [previous, point],
      color: stroke.color,
      size: stroke.size,
      tool: stroke.tool,
      start: false,
    };

    drawStroke(canvasRef.current.getContext("2d"), segment);
    socket.emit("drawing:stroke", segment);
  }

  function stopDrawing() {
    activeStrokeRef.current = null;
  }

  function undoDrawing() {
    if (!canDraw || !room) return;

    activeStrokeRef.current = null;
    socket.emit("drawing:undo");
  }

  function clearCanvas() {
    if (!canDraw || !room) return;

    activeStrokeRef.current = null;
    socket.emit("drawing:clear");
  }

  return (
    <section className="drawing-panel">
      <div className="drawing-toolbar">
        <label>
          Color
          <input
            type="color"
            value={color}
            onChange={(event) => setColor(event.target.value)}
            disabled={!canDraw}
          />
        </label>

        <label>
          Brush: {size}px
          <input
            type="range"
            min="1"
            max="40"
            value={size}
            onChange={(event) => setSize(Number(event.target.value))}
            disabled={!canDraw}
          />
        </label>

        <button
          type="button"
          className={tool === "pen" ? "tool-active" : ""}
          onClick={() => setTool("pen")}
          disabled={!canDraw}
        >
          Pen
        </button>

        <button
          type="button"
          className={tool === "eraser" ? "tool-active" : ""}
          onClick={() => setTool("eraser")}
          disabled={!canDraw}
        >
          Eraser
        </button>

        <button
          type="button"
          onClick={undoDrawing}
          disabled={!canDraw}
        >
          Undo
        </button>

        <button
          type="button"
          onClick={clearCanvas}
          disabled={!canDraw}
        >
          Clear
        </button>
      </div>

      <canvas
        ref={canvasRef}
        width={CANVAS_WIDTH}
        height={CANVAS_HEIGHT}
        className="drawing-canvas"
        onPointerDown={startDrawing}
        onPointerMove={continueDrawing}
        onPointerUp={stopDrawing}
        onPointerCancel={stopDrawing}
        onLostPointerCapture={stopDrawing}
      />
    </section>
  );
}

export default DrawingCanvas;
