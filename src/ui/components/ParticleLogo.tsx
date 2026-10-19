import React, { useEffect, useRef } from 'react';

interface ParticleLogoProps {
  imageSrc: string;
  className?: string;
}

type Particle = {
  x: number; y: number;
  ox: number; oy: number;
  vx: number; vy: number;
  size: number;
  color: string;
  normalizedX: number;
};

export const ParticleLogo: React.FC<ParticleLogoProps> = ({ imageSrc, className = '' }) => {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Guard gegen doppelte Initialisierung (React StrictMode dev)
  const instanceIdRef = useRef(0);

  useEffect(() => {
    let alive = true;

    const wrapper = wrapperRef.current;
    const canvas = canvasRef.current;
    if (!wrapper || !canvas) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true });
    if (!ctx) return;

    instanceIdRef.current += 1;
    const myInstanceId = instanceIdRef.current;

    const img: HTMLImageElement = new Image();
    img.src = imageSrc;

    let particles: Particle[] = [];
    let raf = 0;

    let dpr = Math.max(1, window.devicePixelRatio || 1);
    let rect: DOMRect = canvas.getBoundingClientRect();
    let cssW = 1, cssH = 1;
    let bufW = 1, bufH = 1;

    const pointer = { x: -1e9, y: -1e9, active: false, radius: 90, strength: 1.0 };
    let pendingPointer: PointerEvent | null = null;
    let pointerRaf = 0;

    const updateSizes = () => {
      rect = canvas.getBoundingClientRect();
      cssW = Math.max(1, Math.round(rect.width));
      cssH = Math.max(1, Math.round(rect.height));
      dpr = Math.max(1, window.devicePixelRatio || 1);

      bufW = Math.max(1, Math.floor(cssW * dpr));
      bufH = Math.max(1, Math.floor(cssH * dpr));

      canvas.width = bufW;
      canvas.height = bufH;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = true;
      // @ts-ignore
      if (typeof ctx.imageSmoothingQuality !== 'undefined') ctx.imageSmoothingQuality = 'high';

      pointer.radius = 90 * dpr;
    };

    const computeContainRect = () => {
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      const s = Math.min(bufW / iw, bufH / ih);
      const drawW = iw * s;
      const drawH = ih * s;
      const drawX = (bufW - drawW) / 2;
      const drawY = (bufH - drawH) / 2;
      return { drawX, drawY, drawW, drawH };
    };

    const ALPHA_THRESHOLD = 5;

    const buildParticles = () => {
      updateSizes();
      const { drawX, drawY, drawW, drawH } = computeContainRect();

      const step = 7;

      ctx.clearRect(0, 0, bufW, bufH);
      ctx.drawImage(img, drawX, drawY, drawW, drawH);

      const ix = Math.max(0, Math.floor(drawX));
      const iy = Math.max(0, Math.floor(drawY));
      const iw = Math.min(bufW - ix, Math.ceil(drawW));
      const ih = Math.min(bufH - iy, Math.ceil(drawH));

      const imageData = ctx.getImageData(ix, iy, iw, ih);
      const data = imageData.data;

      particles = [];
      for (let y = 0; y < ih; y += step) {
        for (let x = 0; x < iw; x += step) {
          const i = (y * iw + x) * 4;
          const a = data[i + 3];
          if (a > ALPHA_THRESHOLD) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];

            const cx = ix + x;
            const cy = iy + y;

            const size = (1.2 + Math.random() * 1.05) * dpr;

            particles.push({
              x: cx, y: cy,
              ox: cx, oy: cy,
              vx: 0, vy: 0,
              size,
              color: `rgba(${r},${g},${b},${a / 255})`,
              normalizedX: cx / bufW,
            });
          }
        }
      }

      ctx.clearRect(0, 0, bufW, bufH);
    };

    const applyPendingPointer = () => {
      pointerRaf = 0;
      if (!pendingPointer) return;
      const e = pendingPointer;
      pendingPointer = null;

      const xCss = e.clientX - rect.left;
      const yCss = e.clientY - rect.top;
      pointer.x = xCss * dpr;
      pointer.y = yCss * dpr;
      pointer.active = true;
    };

    const onPointerMove = (e: PointerEvent) => {
      pendingPointer = e;
      if (!pointerRaf) pointerRaf = requestAnimationFrame(applyPendingPointer);
    };

    const onPointerLeave = () => {
      pointer.active = false;
      pointer.x = -1e9;
      pointer.y = -1e9;
    };

    canvas.addEventListener('pointermove', onPointerMove, { passive: true });
    canvas.addEventListener('pointerleave', onPointerLeave, { passive: true });

    const ro = new ResizeObserver(() => {
      if (!alive) return;
      if (instanceIdRef.current !== myInstanceId) return;
      if (img.complete && img.naturalWidth > 0) buildParticles();
    });
    ro.observe(wrapper);

    const RETURN_FORCE_BASE = 0.035;
    const RETURN_FORCE_RIGHT_REDUCE = 0.02;
    const DAMPING = 0.88;
    const MAX_SPEED = 5.5 * dpr;

    const POINTER_FORCE = 1.6 * dpr;
    const SWIRL = 0.10 * dpr;

    const animate = () => {
      if (!alive) return;
      if (instanceIdRef.current !== myInstanceId) return;

      ctx.clearRect(0, 0, bufW, bufH);

      const px = pointer.x;
      const py = pointer.y;
      const r = pointer.radius;
      const r2 = r * r;

      for (const p of particles) {
        const x = p.normalizedX;
        const curve = Math.pow(x, 5);

        const jitterMin = 0.08 * dpr;
        const jitterMax = 0.25 * dpr;
        const jitter = jitterMin + (jitterMax - jitterMin) * curve;

        p.vx += (Math.random() - 0.5) * jitter;
        p.vy += (Math.random() - 0.5) * jitter;

        const dx = p.x - px;
        const dy = p.y - py;
        const dist2 = dx * dx + dy * dy;

        if (pointer.active && dist2 < r2 && dist2 > 0.0001) {
          const dist = Math.sqrt(dist2);
          const nx = dx / dist;
          const ny = dy / dist;

          const t = 1 - dist / r;
          const falloff = t * t;

          const fx = nx * falloff * POINTER_FORCE * pointer.strength;
          const fy = ny * falloff * POINTER_FORCE * pointer.strength;

          const tx = -ny;
          const ty = nx;

          p.vx += fx + tx * falloff * SWIRL;
          p.vy += fy + ty * falloff * SWIRL;
        }

        const returnForce = RETURN_FORCE_BASE - p.normalizedX * RETURN_FORCE_RIGHT_REDUCE;
        p.vx += (p.ox - p.x) * returnForce;
        p.vy += (p.oy - p.y) * returnForce;

        p.vx *= DAMPING;
        p.vy *= DAMPING;

        const sp2 = p.vx * p.vx + p.vy * p.vy;
        const max2 = MAX_SPEED * MAX_SPEED;
        if (sp2 > max2) {
          const sp = Math.sqrt(sp2);
          p.vx = (p.vx / sp) * MAX_SPEED;
          p.vy = (p.vy / sp) * MAX_SPEED;
        }

        p.x += p.vx;
        p.y += p.vy;

        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, p.y, p.size, p.size);
      }

      raf = requestAnimationFrame(animate);
    };

    const waitForImage = async (): Promise<void> => {
      // Prefer decode() when available
      const decodeFn = (img as any).decode as undefined | (() => Promise<void>);
      if (typeof decodeFn === "function") {
        await decodeFn.call(img);
        return;
      }

      if (img.complete && img.naturalWidth > 0) return;

      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Image load failed"));
      });
    };

    const start = async () => {
      try {
        await waitForImage();

        if (!alive) return;
        if (instanceIdRef.current !== myInstanceId) return;

        buildParticles();
        raf = requestAnimationFrame(animate);
      } catch {
        // silent fail (no crash)
      }
    };

    start();

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      if (pointerRaf) cancelAnimationFrame(pointerRaf);
      ro.disconnect();
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
    };
  }, [imageSrc]);

  return (
    <div ref={wrapperRef} className={`relative ${className}`}>
      <canvas ref={canvasRef} className="block w-full h-full" />
    </div>
  );
};