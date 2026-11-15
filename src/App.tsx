import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as THREE from 'three';
import { onAuthStateChanged, User } from 'firebase/auth';
import { DEFAULT_CONFIG, NoelConfig, PhotoItem } from './defaultConfig';
import {
  auth,
  fetchGreetingFromFirebase,
  subscribeToGreeting,
  saveGreetingToFirebase,
  loginWithGoogle,
  logoutGoogle,
  getInitialGreetingIdFromUrl,
  getUserPersonalGreetingId,
  toGreetingSlug,
  shortenUrl,
} from './firebase';
import { generateHeartQrDataUrl } from './heartQr';
import { bgmPlayer, BGM_PRESETS, DEFAULT_BGM } from './bgmPlayer';

const ADMIN_PASS_HASH = '0d0c9bc37ae955b26c8bfecc22fcd072c4ea5ce95947a5051b5ed7399bff4f2e';

async function sha256(str: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export interface CropParams {
  zoom: number;
  offsetX: number;
  offsetY: number;
  rotation: number;
  fitMode: 'cover' | 'contain';
}

export interface AdminPhotoItem extends PhotoItem {
  rawSrc?: string;
  crop?: CropParams;
}

const DEFAULT_CROP: CropParams = {
  zoom: 1,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
  fitMode: 'cover',
};

function readRawFileDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    const fr = new FileReader();
    fr.onload = () => {
      const im = new Image();
      im.onload = () => {
        // Downscale oversized raw camera photos to max 1600px on longest side for smooth interactive panning
        const maxDim = 1600;
        const longest = Math.max(im.width, im.height);
        if (longest <= maxDim) {
          resolve(fr.result as string);
          return;
        }
        const scale = maxDim / longest;
        const c = document.createElement('canvas');
        c.width = Math.round(im.width * scale);
        c.height = Math.round(im.height * scale);
        const ctx = c.getContext('2d');
        if (ctx) {
          ctx.drawImage(im, 0, 0, c.width, c.height);
        }
        resolve(c.toDataURL('image/jpeg', 0.9));
      };
      im.src = fr.result as string;
    };
    fr.readAsDataURL(file);
  });
}

function drawCroppedToCanvas(
  im: HTMLImageElement,
  crop: CropParams,
  canvas: HTMLCanvasElement,
  showGrid = false
) {
  const size = 720;
  if (canvas.width !== size) canvas.width = size;
  if (canvas.height !== size) canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.clearRect(0, 0, size, size);

  // Soft ambient backdrop fill from the image itself (visible when zoomed out or in 'contain' mode)
  ctx.save();
  const bgScale = (size / Math.min(im.width, im.height)) * 1.15;
  ctx.filter = 'blur(22px) brightness(0.55)';
  ctx.drawImage(
    im,
    (size - im.width * bgScale) / 2,
    (size - im.height * bgScale) / 2,
    im.width * bgScale,
    im.height * bgScale
  );
  ctx.restore();

  // Main transformed image
  ctx.save();
  ctx.translate(size / 2 + crop.offsetX * (size / 2), size / 2 + crop.offsetY * (size / 2));
  ctx.rotate((crop.rotation * Math.PI) / 180);

  const baseScale =
    crop.fitMode === 'contain'
      ? size / Math.max(im.width, im.height)
      : size / Math.min(im.width, im.height);
  const totalScale = baseScale * crop.zoom;
  const drawW = im.width * totalScale;
  const drawH = im.height * totalScale;

  ctx.drawImage(im, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  // Optional 3x3 alignment grid for interactive preview
  if (showGrid) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 247, 236, 0.5)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(size / 3, 0);
    ctx.lineTo(size / 3, size);
    ctx.moveTo((size * 2) / 3, 0);
    ctx.lineTo((size * 2) / 3, size);
    ctx.moveTo(0, size / 3);
    ctx.lineTo(size, size / 3);
    ctx.moveTo(0, (size * 2) / 3);
    ctx.lineTo(size, (size * 2) / 3);
    ctx.stroke();
    ctx.restore();
  }
}

function renderCroppedDataUrl(rawSrc: string, crop: CropParams): Promise<string> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      drawCroppedToCanvas(im, crop, c, false);
      resolve(c.toDataURL('image/jpeg', 0.84));
    };
    im.onerror = () => resolve(rawSrc);
    im.src = rawSrc;
  });
}

function normalizeConfig(cfg: NoelConfig): NoelConfig {
  return {
    headline: [
      (cfg.headline?.[0] || 'Chúc Mừng').normalize('NFC'),
      (cfg.headline?.[1] || 'Giáng Sinh').normalize('NFC'),
    ],
    letter: (cfg.letter || []).map((s) => s.normalize('NFC')),
    sign: (cfg.sign || '').normalize('NFC'),
    bgm: cfg.bgm || DEFAULT_BGM,
    photos: (cfg.photos || []).map((p) => ({
      src: p.src || '',
      caption: (p.caption || '').normalize('NFC'),
      url: p.url,
    })),
  };
}

function getInitialConfig(): NoelConfig {
  try {
    const saved = localStorage.getItem('noel_cfg');
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed && Array.isArray(parsed.headline) && Array.isArray(parsed.photos)) {
        return normalizeConfig(parsed);
      }
    }
  } catch {
    // Ignore localStorage parse errors
  }
  return normalizeConfig(DEFAULT_CONFIG);
}

type ModalMode = 'none' | 'letter' | 'photo' | 'gate' | 'admin';

export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [config, setConfig] = useState<NoelConfig>(getInitialConfig);
  const configRef = useRef<NoelConfig>(config);
  configRef.current = config;

  const [stage, setStage] = useState<number>(0);
  const stageRef = useRef<number>(0);
  const [hintText, setHintText] = useState<string>('');
  const [showOpenBtn, setShowOpenBtn] = useState<boolean>(false);
  const [showReadBtn, setShowReadBtn] = useState<boolean>(false);

  const [modalMode, setModalMode] = useState<ModalMode>('none');
  const modalModeRef = useRef<ModalMode>('none');
  modalModeRef.current = modalMode;

  const [activePhoto, setActivePhoto] = useState<PhotoItem | null>(null);
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  // Gate password state
  const [gatePassword, setGatePassword] = useState<string>('');
  const [gateError, setGateError] = useState<string>('');

  // Admin form state
  const [admLine1, setAdmLine1] = useState<string>('');
  const [admLine2, setAdmLine2] = useState<string>('');
  const [admLetter, setAdmLetter] = useState<string>('');
  const [admSign, setAdmSign] = useState<string>('');
  const [admBgm, setAdmBgm] = useState<string>(DEFAULT_BGM);
  const [admPhotos, setAdmPhotos] = useState<AdminPhotoItem[]>([]);
  const [admSlug, setAdmSlug] = useState<string>('');
  const [shareLink, setShareLink] = useState<string>('');
  const [shortShareLink, setShortShareLink] = useState<string>('');
  const [heartQrDataUrl, setHeartQrDataUrl] = useState<string>('');
  const [copiedLink, setCopiedLink] = useState<boolean>(false);
  const [admMsg, setAdmMsg] = useState<string>('');
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);

  // Interactive photo alignment / crop state
  const [editingPhotoIdx, setEditingPhotoIdx] = useState<number | null>(null);
  const [showCropGrid, setShowCropGrid] = useState<boolean>(true);
  const cropCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const loadedCropImgRef = useRef<HTMLImageElement | null>(null);
  const cropDragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    origOffsetX: number;
    origOffsetY: number;
  }>({
    active: false,
    startX: 0,
    startY: 0,
    origOffsetX: 0,
    origOffsetY: 0,
  });

  // Greeting ID from URL (?id=...) or default 'main'
  const [activeGreetingId, setActiveGreetingId] = useState<string>(getInitialGreetingIdFromUrl);

  // Refs to update Three.js scene when config or stage changes
  const sceneUpdaterRef = useRef<{
    updateTextTargets: (headline: [string, string]) => void;
    rebuildPhotos: (photos: PhotoItem[]) => void;
    goStage: (s: number) => void;
  } | null>(null);

  // Listen to Firebase Auth state
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setCurrentUser(u);
      if (u) {
        setAdmSlug((prev) => {
          if (!prev || prev === 'main') {
            return getUserPersonalGreetingId(u);
          }
          return prev;
        });
      }
    });
    return () => unsub();
  }, []);

  // Load config from Firebase Firestore and subscribe to updates for activeGreetingId
  useEffect(() => {
    let mounted = true;
    const gId = activeGreetingId;

    fetchGreetingFromFirebase(gId)
      .then((cloudCfg) => {
        if (!mounted) return;
        if (cloudCfg && cloudCfg.photos.length > 0) {
          const norm = normalizeConfig(cloudCfg);
          setConfig(norm);
          try {
            localStorage.setItem(`noel_cfg_${gId}`, JSON.stringify(norm));
          } catch {
            // Ignore localStorage quota error
          }
        }
      })
      .catch((err) => {
        console.error('Error loading initial config from Firebase:', err);
      });

    const unsub = subscribeToGreeting(gId, (cloudCfg) => {
      if (!mounted) return;
      const norm = normalizeConfig(cloudCfg);
      setConfig(norm);
      try {
        localStorage.setItem(`noel_cfg_${gId}`, JSON.stringify(norm));
      } catch {
        // Ignore localStorage quota error
      }
    });

    return () => {
      mounted = false;
      unsub();
    };
  }, [activeGreetingId]);

  // Sync config updates to Three.js scene and background music
  useEffect(() => {
    if (sceneUpdaterRef.current) {
      sceneUpdaterRef.current.updateTextTargets(config.headline);
      sceneUpdaterRef.current.rebuildPhotos(config.photos);
    }
    bgmPlayer.setTrack(config.bgm || DEFAULT_BGM);
  }, [config]);

  // Start background music on first user interaction (browser autoplay policy friendly)
  useEffect(() => {
    let started = false;
    const unlockAudio = () => {
      if (started) return;
      started = true;
      bgmPlayer.setTrack(configRef.current.bgm || DEFAULT_BGM);
      bgmPlayer.start();
    };
    window.addEventListener('pointerdown', unlockAudio, { once: true });
    window.addEventListener('keydown', unlockAudio, { once: true });
    return () => {
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
    };
  }, []);

  const toggleMute = () => {
    const nextMute = !isMuted;
    setIsMuted(nextMute);
    bgmPlayer.setMuted(nextMute);
  };

  const openAdminForm = useCallback(() => {
    const cur = configRef.current;
    setAdmLine1(cur.headline[0]);
    setAdmLine2(cur.headline[1]);
    setAdmLetter(cur.letter.join('\n\n'));
    setAdmSign(cur.sign);
    setAdmBgm(cur.bgm || DEFAULT_BGM);
    setAdmPhotos(
      cur.photos.map((p) => ({
        src: p.src,
        rawSrc: p.src,
        caption: p.caption,
        crop: { ...DEFAULT_CROP },
      }))
    );
    const initialSlug =
      activeGreetingId !== 'main'
        ? activeGreetingId
        : auth.currentUser
        ? getUserPersonalGreetingId(auth.currentUser)
        : 'noel';
    setAdmSlug(initialSlug);
    const fullUrl = `${window.location.origin}${window.location.pathname}?${initialSlug}`;
    setShareLink(fullUrl);
    setShortShareLink('');
    setCopiedLink(false);
    setEditingPhotoIdx(null);
    setAdmMsg('');
    setModalMode('admin');
  }, [activeGreetingId]);

  const openGate = useCallback(() => {
    setGatePassword('');
    setGateError('');
    setModalMode('gate');
  }, []);

  const closeModal = useCallback(() => {
    setModalMode('none');
  }, []);

  // Initialize Three.js Scene
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const RM = false;
    const R = new THREE.WebGLRenderer({ antialias: true });
    R.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.replaceChildren(R.domElement);

    const S = new THREE.Scene();
    S.background = new THREE.Color(0x0b1622);

    const C = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    const G = new THREE.Group();
    S.add(G);

    function fit() {
      const w = window.innerWidth;
      const h = window.innerHeight;
      R.setSize(w, h);
      C.aspect = w / h;
      C.updateProjectionMatrix();
      C.position.z = Math.max(17, 16 / (2 * Math.tan((25 * Math.PI) / 180) * C.aspect));
    }
    window.addEventListener('resize', fit);
    fit();

    /* Hạt (7000 particles) */
    const N = 7000;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const seed = new Float32Array(N * 4);
    const TP: (Float32Array | null)[] = [
      null,
      new Float32Array(N * 3),
      new Float32Array(N * 3),
      new Float32Array(N * 3),
    ];
    const TC: Float32Array[] = [
      new Float32Array(N * 3),
      new Float32Array(N * 3),
      new Float32Array(N * 3),
      new Float32Array(N * 3),
    ];

    const cc = new THREE.Color();
    const rnd = Math.random;
    const setC = (a: Float32Array, i: number, h: string) => {
      cc.set(h);
      a[i * 3] = cc.r;
      a[i * 3 + 1] = cc.g;
      a[i * 3 + 2] = cc.b;
    };
    const setH = (a: Float32Array, i: number, h: number, s: number, l: number) => {
      cc.setHSL(h, s, l);
      a[i * 3] = cc.r;
      a[i * 3 + 1] = cc.g;
      a[i * 3 + 2] = cc.b;
    };

    for (let i = 0; i < N * 4; i++) seed[i] = rnd();
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (rnd() - 0.5) * 30;
      pos[i * 3 + 1] = (rnd() - 0.5) * 20;
      pos[i * 3 + 2] = (rnd() - 0.5) * 20;
      const r = rnd();
      setC(TC[0], i, r < 0.5 ? '#ffd98a' : r < 0.8 ? '#ffffff' : '#9fd4ff');
    }

    /* Đích 1: Chữ (Headline) */
    function updateTextTargets(headline: [string, string]) {
      const W = 900;
      const H = 420;
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      const x = cv.getContext('2d');
      if (!x || !TP[1]) return;
      x.fillStyle = '#fff';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.font = '700 150px "Be Vietnam Pro",system-ui,"Segoe UI",Arial,sans-serif';
      x.fillText(headline[0] || 'Chúc Mừng', W / 2, H * 0.31);
      x.fillText(headline[1] || 'Giáng Sinh', W / 2, H * 0.7);
      const d = x.getImageData(0, 0, W, H).data;
      const p: [number, number][] = [];
      for (let y = 0; y < H; y += 3) {
        for (let u = 0; u < W; u += 3) {
          if (d[(y * W + u) * 4 + 3] > 128) {
            p.push([((u - W / 2) * 13) / W, (-(y - H / 2) * 13) / W]);
          }
        }
      }
      if (p.length === 0) p.push([0, 0]);
      for (let i = 0; i < N; i++) {
        const q = p[(rnd() * p.length) | 0];
        TP[1][i * 3] = q[0] + (rnd() - 0.5) * 0.05;
        TP[1][i * 3 + 1] = q[1] + (rnd() - 0.5) * 0.05;
        TP[1][i * 3 + 2] = (rnd() - 0.5) * 0.5;
        setC(TC[1], i, rnd() < 0.7 ? '#ffe2a0' : '#ffffff');
      }
    }

    Promise.race([
      document.fonts.load('700 150px "Be Vietnam Pro"', 'Chúc Mừng Giáng Sinh'),
      new Promise((r) => setTimeout(r, 1500)),
    ]).then(
      () => updateTextTargets(configRef.current.headline),
      () => updateTextTargets(configRef.current.headline)
    );

    /* Đích 2: Phong thư (Envelope) */
    (function buildEnvelope() {
      if (!TP[2]) return;
      const w = 4;
      const h = 2.75;
      const P = '#ff7a8a';
      const Y = '#ffd98a';
      const sg: [number, number, number, number, string][] = [
        [-w, -h, w, -h, P],
        [w, -h, w, h, P],
        [w, h, -w, h, P],
        [-w, h, -w, -h, P],
        [-w, h, 0, 0.3, Y],
        [w, h, 0, 0.3, Y],
      ];
      const L = sg.map((s) => Math.hypot(s[2] - s[0], s[3] - s[1]));
      const T = L.reduce((a, b) => a + b, 0);
      for (let i = 0; i < N; i++) {
        let x: number;
        let y: number;
        let c: string;
        if (rnd() < 0.2) {
          x = (rnd() * 2 - 1) * w;
          y = (rnd() * 2 - 1) * h;
          c = '#a8404f';
        } else {
          let r = rnd() * T;
          let k = 0;
          while (r > L[k] && k < L.length - 1) {
            r -= L[k];
            k++;
          }
          const s = sg[k];
          const t = r / L[k];
          x = s[0] + (s[2] - s[0]) * t;
          y = s[1] + (s[3] - s[1]) * t;
          c = s[4];
        }
        TP[2][i * 3] = x + (rnd() - 0.5) * 0.06;
        TP[2][i * 3 + 1] = y + (rnd() - 0.5) * 0.06;
        TP[2][i * 3 + 2] = (rnd() - 0.5) * 0.3;
        setC(TC[2], i, c);
      }
    })();

    /* Đích 3: Cây thông (Christmas Tree) */
    if (TP[3]) {
      for (let i = 0; i < N; i++) {
        const r = rnd();
        let x: number;
        let y: number;
        let z: number;
        if (r < 0.05) {
          const a = rnd() * 6.283;
          const q = rnd() * 0.45;
          x = Math.cos(a) * q;
          z = Math.sin(a) * q;
          y = -5.2 + rnd() * 1;
          setC(TC[3], i, '#8a5a2b');
        } else if (r < 0.07) {
          const a = rnd() * 6.283;
          const b = rnd() * 3.14;
          const q = rnd() * 0.4;
          x = Math.sin(b) * Math.cos(a) * q;
          y = 5 + Math.cos(b) * q;
          z = Math.sin(b) * Math.sin(a) * q;
          setC(TC[3], i, '#fff1b0');
        } else {
          const t = Math.pow(rnd(), 0.85);
          const a = rnd() * 6.283;
          const q = (1 - t) * 3.4 * (0.55 + 0.45 * rnd()) * (0.88 + 0.12 * Math.sin(t * 22));
          x = Math.cos(a) * q;
          z = Math.sin(a) * q;
          y = -4.4 + t * 9.2;
          if (rnd() < 0.12) {
            setC(TC[3], i, ['#ff4d5e', '#ffd98a', '#bfe6ff'][(rnd() * 3) | 0]);
          } else {
            setH(TC[3], i, 0.36 + rnd() * 0.06, 0.6, 0.3 + rnd() * 0.25);
          }
        }
        TP[3][i * 3] = x;
        TP[3][i * 3 + 1] = y;
        TP[3][i * 3 + 2] = z;
      }
    }

    const spr = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const x = c.getContext('2d')!;
      const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, '#fff');
      g.addColorStop(0.4, 'rgba(255,255,255,.6)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      x.fillStyle = g;
      x.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })();

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const pm = new THREE.PointsMaterial({
      size: 0.17,
      map: spr,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    G.add(new THREE.Points(geo, pm));

    /* Tuyết (Snow) */
    const SN = 900;
    const sp = new Float32Array(SN * 3);
    for (let i = 0; i < SN; i++) {
      sp[i * 3] = (rnd() - 0.5) * 36;
      sp[i * 3 + 1] = (rnd() - 0.5) * 18;
      sp[i * 3 + 2] = (rnd() - 0.5) * 14;
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    const sm = new THREE.PointsMaterial({
      size: 0.14,
      map: spr,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    S.add(new THREE.Points(sg, sm));

    /* Ảnh treo (Hanging photos on tree) */
    let photos: THREE.Group[] = [];
    let picMeshes: THREE.Object3D[] = [];

    function rebuildPhotos(photoList: PhotoItem[]) {
      photos.forEach((oldGroup) => {
        G.remove(oldGroup);
      });
      photos = [];
      picMeshes = [];

      photoList.forEach((p, i, arr) => {
        const cv = document.createElement('canvas');
        cv.width = cv.height = 512;
        const x = cv.getContext('2d')!;
        const tex = new THREE.CanvasTexture(cv);
        const draw = (im: HTMLImageElement | null) => {
          if (im) {
            const s = Math.min(im.width, im.height);
            x.drawImage(im, (im.width - s) / 2, (im.height - s) / 2, s, s, 0, 0, 512, 512);
          } else {
            const g = x.createLinearGradient(0, 0, 512, 512);
            g.addColorStop(0, '#ff8a9a');
            g.addColorStop(1, '#ffd98a');
            x.fillStyle = g;
            x.fillRect(0, 0, 512, 512);
            x.fillStyle = '#fff';
            x.textAlign = 'center';
            x.textBaseline = 'middle';
            x.font = '200px sans-serif';
            x.fillText('♥', 256, 220);
            x.font = '500 40px sans-serif';
            x.fillText('Ảnh ' + (i + 1), 256, 400);
          }
          tex.needsUpdate = true;
          p.url = cv.toDataURL('image/jpeg', 0.9);
        };
        draw(null);
        if (p.src) {
          const im = new Image();
          im.crossOrigin = 'anonymous';
          im.onload = () => draw(im);
          im.src = p.src;
        }
        const g = new THREE.Group();
        const back = new THREE.Mesh(
          new THREE.PlaneGeometry(1.5, 1.78),
          new THREE.MeshBasicMaterial({ color: 0xfff7ec, side: THREE.DoubleSide })
        );
        const pic = new THREE.Mesh(
          new THREE.PlaneGeometry(1.3, 1.3),
          new THREE.MeshBasicMaterial({ map: tex })
        );
        pic.position.set(0, 0.14, 0.01);
        g.add(back, pic);
        const hook = new THREE.Mesh(
          new THREE.SphereGeometry(0.07, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0xffd98a })
        );
        hook.position.y = 0.95;
        g.add(hook);

        const y = -2.7 + (i / Math.max(1, arr.length - 1)) * 5.2;
        const a = i * 2.4;
        const r = (1 - (y + 4.4) / 9.2) * 3.4 * 0.95 + 0.3;
        g.position.set(Math.sin(a) * r, y, Math.cos(a) * r);
        g.rotation.set(0, a, i % 2 ? 0.08 : -0.08);
        g.scale.setScalar(stageRef.current === 3 ? 1 : 0.001);
        g.userData = { p, i };
        G.add(g);
        photos.push(g);
        pic.userData.g = g;
        picMeshes.push(pic);
      });
    }

    rebuildPhotos(configRef.current.photos);

    /* Trạng thái & Animation loop */
    let curStage = 0;
    let st = 0;
    let last = performance.now() / 1000;
    const t0 = last;
    let spin = 0;
    let drag = false;
    let moved = 0;
    let px = 0;
    let uiTimer: ReturnType<typeof setTimeout> | null = null;

    function updateUiForStage(s: number) {
      setHintText(
        s === 2
          ? 'Chạm vào phong thư để mở'
          : s === 3
          ? 'Kéo để xoay · chạm vào ảnh để xem'
          : ''
      );
      setShowOpenBtn(s === 2);
      setShowReadBtn(s === 3);
    }

    function goStage(s: number) {
      curStage = s;
      stageRef.current = s;
      setStage(s);
      st = performance.now() / 1000 - t0;
      setShowOpenBtn(false);
      setShowReadBtn(false);
      setHintText('');
      if (uiTimer) clearTimeout(uiTimer);
      uiTimer = setTimeout(() => updateUiForStage(s), s === 2 ? 1800 : s === 3 ? 2600 : 0);
    }

    sceneUpdaterRef.current = {
      updateTextTargets,
      rebuildPhotos,
      goStage,
    };

    const timer1 = setTimeout(() => goStage(1), 3200);
    const timer2 = setTimeout(() => goStage(2), 8400);

    let animId = 0;
    function tick() {
      const now = performance.now() / 1000;
      const dt = Math.min(0.05, now - last);
      const t = now - t0;
      last = now;
      const tp = TP[curStage];
      const tc = TC[curStage];
      const wob = RM ? 0 : 0.03;

      for (let i = 0; i < N; i++) {
        const j = i * 3;
        const s = i * 4;
        let tx: number;
        let ty: number;
        let tz: number;
        if (curStage === 0 || !tp) {
          const a = seed[s] * 6.283 + t * (0.2 + seed[s + 1] * 0.3);
          const b = seed[s + 2] * 3.14 + t * 0.12;
          const r = 5 + seed[s + 3] * 6;
          tx = r * Math.sin(b) * Math.cos(a);
          ty = r * Math.cos(b) * 0.7;
          tz = r * Math.sin(b) * Math.sin(a);
        } else {
          tx = tp[j] + Math.sin(t * 1.7 + i) * wob;
          ty = tp[j + 1] + Math.cos(t * 1.3 + i) * wob;
          tz = tp[j + 2];
        }
        const k = 1 - Math.exp(-dt * (curStage === 0 ? 1.2 : 1.6 + seed[s + 1] * 3));
        pos[j] += (tx - pos[j]) * k;
        pos[j + 1] += (ty - pos[j + 1]) * k;
        pos[j + 2] += (tz - pos[j + 2]) * k;
        col[j] += (tc[j] - col[j]) * k;
        col[j + 1] += (tc[j + 1] - col[j + 1]) * k;
        col[j + 2] += (tc[j + 2] - col[j + 2]) * k;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;

      if (curStage === 3) {
        if (!drag && !RM) spin += dt * 0.15;
        photos.forEach((g, i) => {
          const e = Math.max(0, Math.min(1, (t - st - 1.4 - i * 0.25) / 0.8));
          g.scale.setScalar(0.001 + e * e * (3 - 2 * e));
          g.rotation.x = Math.sin(t * 1.2 + i) * 0.04;
        });
        sm.opacity += (0.8 - sm.opacity) * dt;
      }

      G.rotation.y = curStage === 3 ? spin : Math.sin(t * 0.4) * 0.12;
      G.position.y = Math.sin(t * 0.8) * 0.15;
      pm.size = 0.17 + Math.sin(t * 2.2) * 0.025;

      if (!RM || curStage === 3) {
        for (let i = 0; i < SN; i++) {
          sp[i * 3 + 1] -= dt * (0.8 + (i % 5) * 0.15);
          sp[i * 3] += Math.sin(t * 0.6 + i) * dt * 0.35;
          if (sp[i * 3 + 1] < -9) sp[i * 3 + 1] = 9;
        }
      }
      sg.attributes.position.needsUpdate = true;
      C.lookAt(0, 0, 0);
      R.render(S, C);
      animId = requestAnimationFrame(tick);
    }
    animId = requestAnimationFrame(tick);

    /* Tương tác trên Canvas & Nhận diện cử chỉ vẽ chữ "T" mở Quản trị */
    const ray = new THREE.Raycaster();
    const cv = R.domElement;

    type StrokePoint = { x: number; y: number };
    type ClassifiedStroke =
      | { type: 'H'; minX: number; maxX: number; avgY: number; time: number }
      | { type: 'V'; avgX: number; minY: number; maxY: number; time: number };

    let currentStroke: StrokePoint[] = [];
    let lastStroke: ClassifiedStroke | null = null;

    function detectLetterT(pts: StrokePoint[]): boolean {
      if (pts.length < 4 || modalModeRef.current !== 'none') return false;
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      const width = maxX - minX;
      const height = maxY - minY;
      const start = pts[0];
      const end = pts[pts.length - 1];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const nowMs = performance.now();

      // 1. Kiểm tra vẽ chữ T bằng 1 nét liền (kéo ngang ở trên rồi kéo dọc xuống dưới)
      if (
        width >= 55 &&
        height >= 55 &&
        start.y <= minY + height * 0.38 &&
        end.y >= minY + height * 0.72
      ) {
        const topBandY = minY + height * 0.38;
        const botBandY = minY + height * 0.5;
        let topMinX = Infinity;
        let topMaxX = -Infinity;
        let botMinX = Infinity;
        let botMaxX = -Infinity;
        let topCount = 0;
        let botCount = 0;

        for (const p of pts) {
          if (p.y <= topBandY) {
            if (p.x < topMinX) topMinX = p.x;
            if (p.x > topMaxX) topMaxX = p.x;
            topCount++;
          }
          if (p.y >= botBandY) {
            if (p.x < botMinX) botMinX = p.x;
            if (p.x > botMaxX) botMaxX = p.x;
            botCount++;
          }
        }

        const topSpan = topCount > 1 ? topMaxX - topMinX : 0;
        const botSpan = botCount > 1 ? botMaxX - botMinX : Infinity;
        if (topSpan >= width * 0.65 && botSpan <= width * 0.65) {
          lastStroke = null;
          return true;
        }
      }

      // 2. Phân loại nét đơn (Nét ngang 'H' hoặc Nét sổ dọc 'V') để ghép chữ T 2 nét
      let curr: ClassifiedStroke | null = null;
      if (width >= 45 && height <= Math.max(48, width * 0.48) && Math.abs(dx) >= 40) {
        curr = {
          type: 'H',
          minX,
          maxX,
          avgY: (minY + maxY) / 2,
          time: nowMs,
        };
      } else if (height >= 45 && width <= Math.max(48, height * 0.48) && dy >= 40) {
        curr = {
          type: 'V',
          avgX: (minX + maxX) / 2,
          minY,
          maxY,
          time: nowMs,
        };
      }

      if (!curr) {
        lastStroke = null;
        return false;
      }

      if (lastStroke && nowMs - lastStroke.time <= 2200) {
        // Nét 1 ngang (─) + Nét 2 sổ dọc (│)
        if (lastStroke.type === 'H' && curr.type === 'V') {
          const hLen = lastStroke.maxX - lastStroke.minX;
          const xInBar =
            curr.avgX >= lastStroke.minX - hLen * 0.35 &&
            curr.avgX <= lastStroke.maxX + hLen * 0.35;
          const yStartsNearBar =
            curr.minY >= lastStroke.avgY - 80 && curr.minY <= lastStroke.avgY + 90;
          const extendsBelow = curr.maxY > lastStroke.avgY + 35;
          if (xInBar && yStartsNearBar && extendsBelow) {
            lastStroke = null;
            return true;
          }
        }
        // Nét 1 sổ dọc (│) + Nét 2 ngang ở đỉnh (─)
        if (lastStroke.type === 'V' && curr.type === 'H') {
          const hLen = curr.maxX - curr.minX;
          const vLen = lastStroke.maxY - lastStroke.minY;
          const xInBar =
            lastStroke.avgX >= curr.minX - hLen * 0.35 &&
            lastStroke.avgX <= curr.maxX + hLen * 0.35;
          const yNearTop =
            curr.avgY >= lastStroke.minY - 70 &&
            curr.avgY <= lastStroke.minY + vLen * 0.55;
          if (xInBar && yNearTop) {
            lastStroke = null;
            return true;
          }
        }
      }

      lastStroke = curr;
      return false;
    }

    const onPointerDown = (e: PointerEvent) => {
      drag = true;
      moved = 0;
      px = e.clientX;
      currentStroke = [{ x: e.clientX, y: e.clientY }];
      cv.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!drag) return;
      const dx = e.clientX - px;
      px = e.clientX;
      moved += Math.abs(dx);
      if (currentStroke.length < 300) {
        currentStroke.push({ x: e.clientX, y: e.clientY });
      }
      if (curStage === 3) spin += dx * 0.008;
    };

    const onPointerUp = (e: PointerEvent) => {
      drag = false;
      currentStroke.push({ x: e.clientX, y: e.clientY });
      if (detectLetterT(currentStroke)) {
        currentStroke = [];
        openGate();
        return;
      }
      currentStroke = [];
      if (moved > 6) return;
      if (curStage === 2) {
        goStage(3);
        return;
      }
      if (curStage !== 3) return;
      ray.setFromCamera(
        new THREE.Vector2(
          (e.clientX / window.innerWidth) * 2 - 1,
          -(e.clientY / window.innerHeight) * 2 + 1
        ),
        C
      );
      const hit = ray.intersectObjects(picMeshes)[0];
      if (hit && hit.object.userData.g && hit.object.userData.g.scale.x > 0.8) {
        const p: PhotoItem = hit.object.userData.g.userData.p;
        setActivePhoto({
          src: p.url || p.src,
          caption: p.caption,
          url: p.url || p.src,
        });
        setModalMode('photo');
      }
    };

    cv.addEventListener('pointerdown', onPointerDown);
    cv.addEventListener('pointermove', onPointerMove);
    cv.addEventListener('pointerup', onPointerUp);

    return () => {
      cancelAnimationFrame(animId);
      if (uiTimer) clearTimeout(uiTimer);
      clearTimeout(timer1);
      clearTimeout(timer2);
      window.removeEventListener('resize', fit);
      cv.removeEventListener('pointerdown', onPointerDown);
      cv.removeEventListener('pointermove', onPointerMove);
      cv.removeEventListener('pointerup', onPointerUp);
      R.dispose();
    };
  }, [openGate]);

  // Keyboard listener (Escape to close unlocked modals, M to open Admin Gate)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mode = modalModeRef.current;
      if (e.key === 'Escape' && (mode === 'letter' || mode === 'photo')) {
        closeModal();
      }
      const activeTag = document.activeElement?.tagName || '';
      if (
        e.key.toLowerCase() === 'm' &&
        mode === 'none' &&
        !e.ctrlKey &&
        !e.metaKey &&
        !/INPUT|TEXTAREA/.test(activeTag)
      ) {
        e.preventDefault();
        openGate();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeModal, openGate]);

  const handleGateSubmit = async () => {
    const hashed = await sha256(gatePassword.trim());
    if (hashed === ADMIN_PASS_HASH) {
      openAdminForm();
    } else {
      setGateError('Sai mật khẩu.');
      setGatePassword('');
    }
  };

  const handleGoogleAdminLogin = async () => {
    try {
      setGateError('');
      await loginWithGoogle();
      openAdminForm();
    } catch (err) {
      setGateError(
        err instanceof Error ? err.message : 'Không thể đăng nhập Google. Vui lòng thử lại.'
      );
    }
  };

  const editingPhoto =
    editingPhotoIdx !== null && admPhotos[editingPhotoIdx] ? admPhotos[editingPhotoIdx] : null;
  const activeCrop: CropParams = editingPhoto?.crop || DEFAULT_CROP;
  const activeRawSrc = editingPhoto ? editingPhoto.rawSrc || editingPhoto.src : '';

  // Load image object and draw live crop preview whenever activeRawSrc or activeCrop changes
  useEffect(() => {
    if (editingPhotoIdx === null || !activeRawSrc) {
      loadedCropImgRef.current = null;
      return;
    }
    let cancelled = false;
    const im = new Image();
    im.onload = () => {
      if (cancelled) return;
      loadedCropImgRef.current = im;
      if (cropCanvasRef.current) {
        drawCroppedToCanvas(im, activeCrop, cropCanvasRef.current, showCropGrid);
      }
    };
    im.src = activeRawSrc;
    return () => {
      cancelled = true;
    };
  }, [editingPhotoIdx, activeRawSrc]);

  useEffect(() => {
    if (
      editingPhotoIdx !== null &&
      loadedCropImgRef.current &&
      cropCanvasRef.current
    ) {
      drawCroppedToCanvas(
        loadedCropImgRef.current,
        activeCrop,
        cropCanvasRef.current,
        showCropGrid
      );
    }
  }, [editingPhotoIdx, activeCrop, showCropGrid]);

  const updateEditingCrop = useCallback(
    (updater: (prevCrop: CropParams) => CropParams) => {
      if (editingPhotoIdx === null) return;
      setAdmPhotos((prev) => {
        const target = prev[editingPhotoIdx];
        if (!target) return prev;
        const nextCrop = updater(target.crop || DEFAULT_CROP);
        const nextList = [...prev];
        nextList[editingPhotoIdx] = {
          ...target,
          crop: nextCrop,
        };
        // Also update the cropped thumbnail asynchronously if image is ready
        if (loadedCropImgRef.current) {
          const tempCanvas = document.createElement('canvas');
          drawCroppedToCanvas(loadedCropImgRef.current, nextCrop, tempCanvas, false);
          nextList[editingPhotoIdx].src = tempCanvas.toDataURL('image/jpeg', 0.84);
        }
        return nextList;
      });
    },
    [editingPhotoIdx]
  );

  const handleCropPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    cropDragRef.current = {
      active: true,
      startX: e.clientX,
      startY: e.clientY,
      origOffsetX: activeCrop.offsetX,
      origOffsetY: activeCrop.offsetY,
    };
  };

  const handleCropPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!cropDragRef.current.active) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const boxSize = Math.max(1, rect.width);
    const dx = ((e.clientX - cropDragRef.current.startX) / (boxSize / 2));
    const dy = ((e.clientY - cropDragRef.current.startY) / (boxSize / 2));
    const clampedX = Math.max(-1.5, Math.min(1.5, cropDragRef.current.origOffsetX + dx));
    const clampedY = Math.max(-1.5, Math.min(1.5, cropDragRef.current.origOffsetY + dy));

    updateEditingCrop((prev) => ({
      ...prev,
      offsetX: clampedX,
      offsetY: clampedY,
    }));
  };

  const handleCropPointerUp = () => {
    cropDragRef.current.active = false;
  };

  const handleCropWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    updateEditingCrop((prev) => ({
      ...prev,
      zoom: Math.max(0.5, Math.min(3.0, Number((prev.zoom + delta).toFixed(2)))),
    }));
  };

  const handlePickPhoto = (multiple: boolean, replaceIndex?: number) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = multiple;
    input.onchange = async () => {
      if (!input.files) return;
      const files = Array.from(input.files);
      if (!multiple && typeof replaceIndex === 'number' && files[0]) {
        const rawUrl = await readRawFileDataUrl(files[0]);
        const initialCrop: CropParams = { ...DEFAULT_CROP };
        const croppedUrl = await renderCroppedDataUrl(rawUrl, initialCrop);
        setAdmPhotos((prev) =>
          prev.map((item, idx) =>
            idx === replaceIndex
              ? { ...item, src: croppedUrl, rawSrc: rawUrl, crop: initialCrop }
              : item
          )
        );
        setEditingPhotoIdx(replaceIndex);
      } else if (multiple) {
        const newItems: AdminPhotoItem[] = [];
        for (const f of files) {
          const rawUrl = await readRawFileDataUrl(f);
          const initialCrop: CropParams = { ...DEFAULT_CROP };
          const croppedUrl = await renderCroppedDataUrl(rawUrl, initialCrop);
          newItems.push({
            src: croppedUrl,
            rawSrc: rawUrl,
            caption: '',
            crop: initialCrop,
          });
        }
        setAdmPhotos((prev) => {
          const startIdx = prev.length;
          const combined = [...prev];
          for (const ni of newItems) {
            if (combined.length < 12) {
              combined.push({
                ...ni,
                caption: `Kỷ niệm ${combined.length + 1}`,
              });
            }
          }
          if (combined.length > startIdx) {
            setEditingPhotoIdx(startIdx);
          }
          return combined;
        });
      }
    };
    input.click();
  };

  const handleUploadBgmFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 420 * 1024) {
        setAdmMsg('File nhạc tải trực tiếp cần nhỏ hơn 420KB (hoặc bạn có thể dán link MP3 trực tuyến bất kỳ).');
        return;
      }
      const fr = new FileReader();
      fr.onload = () => {
        const dataUrl = fr.result as string;
        setAdmBgm(dataUrl);
        bgmPlayer.setTrack(dataUrl);
        bgmPlayer.start();
        setAdmMsg(`Đã chọn file nhạc: ${file.name}. Bấm "Lưu và cập nhật" để áp dụng.`);
      };
      fr.readAsDataURL(file);
    };
    input.click();
  };

  const buildUpdatedConfig = (): NoelConfig => {
    const h1 = admLine1.normalize('NFC').trim() || 'Chúc Mừng';
    const h2 = admLine2.normalize('NFC').trim() || 'Giáng Sinh';
    const paragraphs = admLetter
      .normalize('NFC')
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      headline: [h1, h2],
      letter: paragraphs.length > 0 ? paragraphs : ['Giáng Sinh An Lành!'],
      sign: admSign.normalize('NFC').trim() || 'Bạn của bạn',
      bgm: admBgm.trim() || DEFAULT_BGM,
      photos: admPhotos.map((p, idx) => ({
        src: p.src,
        caption: p.caption.normalize('NFC').trim() || `Kỷ niệm ${idx + 1}`,
      })),
    };
  };

  const handleSaveToFirebase = async () => {
    const newCfg = buildUpdatedConfig();
    setIsSaving(true);
    setCopiedLink(false);
    setAdmMsg('Đang lưu và tạo link ngắn trên Firebase...');
    try {
      let user = auth.currentUser;
      if (!user) {
        setAdmMsg('Vui lòng xác nhận đăng nhập Google trong cửa sổ bật lên để tạo link riêng...');
        const cred = await loginWithGoogle();
        user = cred.user;
      }
      const desiredSlug =
        toGreetingSlug(admSlug) || (user ? getUserPersonalGreetingId(user) : 'u1');
      const savedId = await saveGreetingToFirebase(newCfg, desiredSlug);
      setActiveGreetingId(savedId);
      setAdmSlug(savedId);
      const personalUrl = `${window.location.origin}${window.location.pathname}?${savedId}`;
      setShareLink(personalUrl);
      setShortShareLink('');
      window.history.replaceState(null, '', `?${savedId}`);

      shortenUrl(personalUrl).then((sUrl) => {
        if (sUrl) setShortShareLink(sUrl);
      });

      setConfig(newCfg);
      try {
        localStorage.setItem(`noel_cfg_${savedId}`, JSON.stringify(newCfg));
      } catch {
        // Ignore localStorage quota limit since Firebase is primary storage
      }
      setAdmMsg(
        `Đã lưu thành công! Đường dẫn riêng của bạn có đuôi ?${savedId} (và link rút gọn bên trên) để gửi ngay cho người nhận.`
      );
    } catch (err) {
      let friendlyMsg = 'Không thể lưu lên Firebase.';
      if (err instanceof Error) {
        try {
          const parsed = JSON.parse(err.message);
          if (parsed && parsed.error) {
            friendlyMsg = `Lỗi quyền truy cập Firebase: ${parsed.error}. Hãy đảm bảo bạn đã đăng nhập Google.`;
          } else {
            friendlyMsg = err.message;
          }
        } catch {
          friendlyMsg = err.message;
        }
      }
      setAdmMsg(friendlyMsg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCopyShareLink = async (urlToCopy?: string) => {
    const targetUrl = urlToCopy || shortShareLink || shareLink;
    if (!targetUrl) return;
    try {
      await navigator.clipboard.writeText(targetUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 3000);
    } catch {
      const input = document.createElement('input');
      input.value = targetUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 3000);
    }
  };

  // Keep shareLink, shortShareLink, and Heart QR code synchronized in Admin mode
  useEffect(() => {
    if (modalMode !== 'admin') return;
    const baseOrigin = `${window.location.origin}${window.location.pathname}`;
    const slugPart = admSlug || (currentUser ? getUserPersonalGreetingId(currentUser) : 'noel');
    const directUrl = `${baseOrigin}?${slugPart}`;
    setShareLink(directUrl);

    try {
      const dataUrl = generateHeartQrDataUrl(directUrl);
      setHeartQrDataUrl(dataUrl);
    } catch (e) {
      console.error('Error generating Heart QR:', e);
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      shortenUrl(directUrl).then((sUrl) => {
        if (cancelled) return;
        if (sUrl) {
          setShortShareLink(sUrl);
          try {
            setHeartQrDataUrl(generateHeartQrDataUrl(sUrl));
          } catch {
            // Keep directUrl QR if shortUrl QR fails
          }
        } else {
          setShortShareLink('');
        }
      });
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [modalMode, admSlug, currentUser]);

  const handleDownloadHeartQr = () => {
    if (!heartQrDataUrl) return;
    const a = document.createElement('a');
    a.href = heartQrDataUrl;
    a.download = `qr-trai-tim-${admSlug || 'noel'}.png`;
    a.click();
  };

  const handleDownloadConfigJs = () => {
    const newCfg = buildUpdatedConfig();
    const blob = new Blob(['const CONFIG = ' + JSON.stringify(newCfg, null, 2) + ';'], {
      type: 'application/javascript',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'config.js';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setAdmMsg('Đã tải file config.js dự phòng về máy.');
  };

  return (
    <>
      <div ref={mountRef} />

      {config.bgm !== 'none' && (
        <button
          type="button"
          onClick={toggleMute}
          title={isMuted ? 'Bật nhạc nền' : 'Tắt nhạc nền'}
          style={{
            position: 'fixed',
            top: '14px',
            left: '14px',
            zIndex: 20,
            width: '38px',
            height: '38px',
            borderRadius: '999px',
            border: '1px solid rgba(255, 217, 138, 0.35)',
            background: 'rgba(11, 22, 34, 0.55)',
            color: '#ffd98a',
            fontSize: '1rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            backdropFilter: 'blur(6px)',
          }}
        >
          {isMuted ? '🔇' : '♫'}
        </button>
      )}

      <div className="ui">
        <p className="hint" id="hint">
          {hintText}
        </p>
        {showOpenBtn && stage === 2 && (
          <button
            type="button"
            className="btn"
            id="open"
            onClick={() => sceneUpdaterRef.current?.goStage(3)}
          >
            Mở thư
          </button>
        )}
        {showReadBtn && stage === 3 && (
          <button
            type="button"
            className="btn"
            id="read"
            onClick={() => setModalMode('letter')}
          >
            Đọc lá thư
          </button>
        )}
      </div>

      {modalMode !== 'none' && (
        <div
          id="ov"
          data-lock={modalMode === 'gate' || modalMode === 'admin' ? 1 : undefined}
          onClick={(e) => {
            if (
              e.target === e.currentTarget &&
              modalMode !== 'gate' &&
              modalMode !== 'admin'
            ) {
              closeModal();
            }
          }}
        >
          {modalMode === 'letter' && (
            <div className="paper">
              {config.letter.map((paragraph, idx) => (
                <p key={idx}>{paragraph}</p>
              ))}
              <p className="sign">{config.sign}</p>
              <button type="button" className="btn close" onClick={closeModal}>
                Đóng
              </button>
            </div>
          )}

          {modalMode === 'photo' && activePhoto && (
            <div className="pic">
              <img src={activePhoto.url || activePhoto.src} alt={activePhoto.caption} />
              <p>{activePhoto.caption}</p>
            </div>
          )}

          {modalMode === 'gate' && (
            <div className="paper adm">
              <h2>Quản trị</h2>
              <label className="lab">
                <span>Mật khẩu quản trị</span>
                <input
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={gatePassword}
                  onChange={(e) => setGatePassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleGateSubmit();
                  }}
                  placeholder="Nhập mật khẩu hoặc đăng nhập Google bên dưới"
                  autoFocus
                />
              </label>
              {gateError && <p className="hint" style={{ color: '#b91c1c', opacity: 1 }}>{gateError}</p>}
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <button
                  type="button"
                  className="sm"
                  onClick={handleGoogleAdminLogin}
                >
                  {currentUser ? `Tiếp tục với ${currentUser.email}` : 'Đăng nhập Google'}
                </button>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button type="button" className="sm close" onClick={closeModal}>
                    Đóng
                  </button>
                  <button type="button" className="btn" onClick={handleGateSubmit}>
                    Mở
                  </button>
                </div>
              </div>
            </div>
          )}

          {modalMode === 'admin' && (
            <div className="paper adm">
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '8px',
                  marginBottom: '12px',
                }}
              >
                <h2 style={{ margin: 0 }}>Quản trị (Lưu trực tiếp Firebase)</h2>
                {currentUser ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.8rem' }}>
                    <span style={{ color: '#15803d', fontWeight: 500 }}>
                      ● {currentUser.email}
                    </span>
                    <button
                      type="button"
                      className="sm"
                      style={{ minHeight: '30px', padding: '4px 10px', fontSize: '0.75rem' }}
                      onClick={() => logoutGoogle()}
                    >
                      Đăng xuất
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="sm"
                    style={{ minHeight: '32px', padding: '4px 12px', fontSize: '0.8rem' }}
                    onClick={() => loginWithGoogle()}
                  >
                    Đăng nhập Google để lưu Cloud
                  </button>
                )}
              </div>

              <div
                style={{
                  background: '#f5e8d8',
                  border: '1px solid #d9c3b8',
                  borderRadius: '8px',
                  padding: '12px',
                  marginBottom: '14px',
                }}
              >
                <label className="lab" style={{ marginBottom: shareLink ? '10px' : 0 }}>
                  <span>
                    Ký tự nhận diện ngắn ở cuối link (1–15 ký tự, ví dụ: <b>t</b>, <b>em</b>, <b>noel</b>)
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                    <span
                      style={{
                        fontSize: '0.9rem',
                        color: '#6b4f3f',
                        whiteSpace: 'nowrap',
                        fontFamily: 'monospace',
                        fontWeight: 700,
                      }}
                    >
                      ?
                    </span>
                    <input
                      style={{ marginTop: 0 }}
                      value={admSlug}
                      maxLength={20}
                      placeholder={
                        currentUser
                          ? getUserPersonalGreetingId(currentUser)
                          : 'vd: t, em, linh...'
                      }
                      onChange={(e) => setAdmSlug(toGreetingSlug(e.target.value))}
                    />
                  </div>
                </label>

                {shareLink && (
                  <div
                    style={{
                      background: '#fffdf9',
                      border: '1px solid #15803d',
                      borderRadius: '6px',
                      padding: '8px 10px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                      marginBottom: '10px',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '8px',
                        flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: '0.75rem', color: '#15803d', fontWeight: 600 }}>
                          {shortShareLink
                            ? 'Link rút gọn siêu ngắn (gửi link này cho người nhận):'
                            : 'Link thiệp riêng của bạn:'}
                        </div>
                        <div
                          style={{
                            fontSize: '0.88rem',
                            fontFamily: 'monospace',
                            fontWeight: 600,
                            wordBreak: 'break-all',
                            color: '#2a1a1c',
                          }}
                        >
                          {shortShareLink || shareLink}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="btn"
                        style={{ minHeight: '34px', padding: '6px 14px', fontSize: '0.8rem' }}
                        onClick={() => handleCopyShareLink(shortShareLink || shareLink)}
                      >
                        {copiedLink ? '✓ Đã sao chép' : 'Sao chép link'}
                      </button>
                    </div>
                    {shortShareLink && (
                      <div
                        style={{
                          fontSize: '0.72rem',
                          color: '#6b4f3f',
                          fontFamily: 'monospace',
                          wordBreak: 'break-all',
                        }}
                      >
                        Link gốc: {shareLink}
                      </div>
                    )}
                  </div>
                )}

                {heartQrDataUrl && (
                  <div
                    style={{
                      background: '#fffdf9',
                      border: '1px solid #f4b4be',
                      borderRadius: '8px',
                      padding: '10px 12px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '12px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flex: 1, minWidth: '200px' }}>
                      <img
                        src={heartQrDataUrl}
                        alt="Mã QR Hình Trái Tim"
                        style={{
                          width: '96px',
                          height: '106px',
                          objectFit: 'contain',
                          borderRadius: '6px',
                          border: '1px solid #fecdd3',
                          background: '#fff',
                          flex: 'none',
                        }}
                      />
                      <div>
                        <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#9f1239' }}>
                          ♥ Mã QR Hình Trái Tim
                        </div>
                        <div style={{ fontSize: '0.76rem', color: '#6b4f3f', lineHeight: 1.4, marginTop: '2px' }}>
                          {shareLink
                            ? 'Mã QR đã gắn với link riêng của bạn. Quét bằng điện thoại để mở thiệp ngay!'
                            : 'Bấm "Lưu và cập nhật" ở dưới để khoá link riêng vào mã QR Trái Tim trước khi gửi.'}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn"
                      style={{
                        background: '#e11d48',
                        color: '#fff',
                        minHeight: '36px',
                        padding: '8px 16px',
                        fontSize: '0.82rem',
                      }}
                      onClick={handleDownloadHeartQr}
                    >
                      ♥ Tải QR Trái Tim (.PNG)
                    </button>
                  </div>
                )}
              </div>

              <label className="lab">
                <span>Dòng chữ chúc thứ nhất</span>
                <input
                  value={admLine1}
                  maxLength={100}
                  onChange={(e) => setAdmLine1(e.target.value)}
                />
              </label>

              <label className="lab">
                <span>Dòng chữ chúc thứ hai</span>
                <input
                  value={admLine2}
                  maxLength={100}
                  onChange={(e) => setAdmLine2(e.target.value)}
                />
              </label>

              <label className="lab">
                <span>Nội dung thư (cách đoạn bằng một dòng trống)</span>
                <textarea
                  rows={7}
                  maxLength={10000}
                  value={admLetter}
                  onChange={(e) => setAdmLetter(e.target.value)}
                />
              </label>

              <label className="lab">
                <span>Lời ký tên</span>
                <input
                  value={admSign}
                  maxLength={200}
                  onChange={(e) => setAdmSign(e.target.value)}
                />
              </label>

              <div
                style={{
                  background: '#f5e8d8',
                  border: '1px solid #d9c3b8',
                  borderRadius: '8px',
                  padding: '12px',
                  marginBottom: '14px',
                }}
              >
                <label className="lab" style={{ marginBottom: '8px' }}>
                  <span>♫ Nhạc nền Giáng Sinh (chọn giai điệu có sẵn hoặc dùng nhạc riêng)</span>
                  <select
                    style={{
                      display: 'block',
                      width: '100%',
                      marginTop: '6px',
                      padding: '10px',
                      font: '0.95rem "Be Vietnam Pro", system-ui, sans-serif',
                      border: '1px solid #d9c3b8',
                      borderRadius: '6px',
                      background: '#fff',
                      color: '#2a1a1c',
                    }}
                    value={
                      BGM_PRESETS.some((p) => p.id === admBgm) ? admBgm : 'custom'
                    }
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === 'custom') {
                        setAdmBgm('https://');
                      } else {
                        setAdmBgm(val);
                        bgmPlayer.setTrack(val);
                        bgmPlayer.start();
                      }
                    }}
                  >
                    {BGM_PRESETS.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label}
                      </option>
                    ))}
                    <option value="custom">🎵 Nhạc tự chọn (Link MP3 hoặc tải file nhạc)</option>
                  </select>
                </label>

                {!BGM_PRESETS.some((p) => p.id === admBgm) && (
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '8px' }}>
                    <input
                      style={{
                        flex: 1,
                        minWidth: '180px',
                        padding: '8px 10px',
                        font: '0.9rem "Be Vietnam Pro", system-ui, sans-serif',
                        border: '1px solid #d9c3b8',
                        borderRadius: '6px',
                        background: '#fff',
                        color: '#2a1a1c',
                      }}
                      value={admBgm.startsWith('data:audio/') ? '(Đã tải file nhạc từ máy)' : admBgm}
                      placeholder="Dán link file nhạc .mp3 (https://...)"
                      onChange={(e) => {
                        const url = e.target.value;
                        setAdmBgm(url);
                      }}
                    />
                    <button
                      type="button"
                      className="sm"
                      onClick={handleUploadBgmFile}
                    >
                      Tải file nhạc
                    </button>
                    <button
                      type="button"
                      className="sm"
                      onClick={() => {
                        bgmPlayer.setTrack(admBgm);
                        bgmPlayer.start();
                      }}
                    >
                      ▶ Nghe thử
                    </button>
                  </div>
                )}
              </div>

              <h3>
                Ảnh trên cây thông ({admPhotos.length}/12){' '}
                <span style={{ fontWeight: 400, fontSize: '0.8rem', opacity: 0.75 }}>
                  — bấm vào ảnh hoặc nút "Canh chỉnh" để kéo/phóng to/xoay
                </span>
              </h3>

              {editingPhotoIdx !== null && editingPhoto && (
                <div className="crop-panel">
                  <div className="crop-header">
                    <h3>
                      Canh chỉnh ảnh #{editingPhotoIdx + 1}:{' '}
                      <span style={{ fontWeight: 400 }}>
                        {editingPhoto.caption || `Kỷ niệm ${editingPhotoIdx + 1}`}
                      </span>
                    </h3>
                    <button
                      type="button"
                      className="btn"
                      style={{ minHeight: '34px', padding: '6px 16px', fontSize: '0.85rem' }}
                      onClick={() => setEditingPhotoIdx(null)}
                    >
                      Xong canh chỉnh
                    </button>
                  </div>

                  <div className="crop-stage-wrap">
                    <div className="crop-polaroid">
                      <canvas
                        ref={cropCanvasRef}
                        className="crop-canvas"
                        onPointerDown={handleCropPointerDown}
                        onPointerMove={handleCropPointerMove}
                        onPointerUp={handleCropPointerUp}
                        onPointerCancel={handleCropPointerUp}
                        onWheel={handleCropWheel}
                      />
                    </div>
                    <p className="hint" style={{ fontSize: '0.8rem', color: '#5c4033', opacity: 0.9 }}>
                      Kéo trực tiếp trên ảnh để di chuyển vị trí • Lăn chuột hoặc kéo thanh trượt để phóng to/thu nhỏ
                    </p>

                    <div className="crop-controls">
                      <div className="crop-slider-row">
                        <span className="lbl">Thu phóng</span>
                        <input
                          type="range"
                          min="0.5"
                          max="3"
                          step="0.02"
                          value={activeCrop.zoom}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            updateEditingCrop((prev) => ({ ...prev, zoom: val }));
                          }}
                        />
                        <span className="val">{Math.round(activeCrop.zoom * 100)}%</span>
                      </div>

                      <div className="crop-slider-row">
                        <span className="lbl">Ngang (X)</span>
                        <input
                          type="range"
                          min="-1"
                          max="1"
                          step="0.01"
                          value={activeCrop.offsetX}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            updateEditingCrop((prev) => ({ ...prev, offsetX: val }));
                          }}
                        />
                        <span className="val">{Math.round(activeCrop.offsetX * 100)}%</span>
                      </div>

                      <div className="crop-slider-row">
                        <span className="lbl">Dọc (Y)</span>
                        <input
                          type="range"
                          min="-1"
                          max="1"
                          step="0.01"
                          value={activeCrop.offsetY}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            updateEditingCrop((prev) => ({ ...prev, offsetY: val }));
                          }}
                        />
                        <span className="val">{Math.round(activeCrop.offsetY * 100)}%</span>
                      </div>

                      <div className="crop-slider-row">
                        <span className="lbl">Góc xoay</span>
                        <input
                          type="range"
                          min="-180"
                          max="180"
                          step="1"
                          value={activeCrop.rotation}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10);
                            updateEditingCrop((prev) => ({ ...prev, rotation: val }));
                          }}
                        />
                        <span className="val">{activeCrop.rotation}°</span>
                      </div>

                      <div className="crop-quick-btns">
                        <button
                          type="button"
                          className="sm"
                          style={
                            activeCrop.fitMode === 'cover'
                              ? { background: '#ffd98a', borderColor: '#b45309', fontWeight: 600 }
                              : undefined
                          }
                          onClick={() =>
                            updateEditingCrop((prev) => ({
                              ...prev,
                              fitMode: 'cover',
                              zoom: 1,
                              offsetX: 0,
                              offsetY: 0,
                            }))
                          }
                        >
                          Lấp đầy khung (1:1)
                        </button>
                        <button
                          type="button"
                          className="sm"
                          style={
                            activeCrop.fitMode === 'contain'
                              ? { background: '#ffd98a', borderColor: '#b45309', fontWeight: 600 }
                              : undefined
                          }
                          onClick={() =>
                            updateEditingCrop((prev) => ({
                              ...prev,
                              fitMode: 'contain',
                              zoom: 1,
                              offsetX: 0,
                              offsetY: 0,
                            }))
                          }
                        >
                          Vừa toàn bộ ảnh
                        </button>
                        <button
                          type="button"
                          className="sm"
                          onClick={() =>
                            updateEditingCrop((prev) => ({
                              ...prev,
                              rotation: ((prev.rotation - 90 + 540) % 360) - 180,
                            }))
                          }
                        >
                          ↺ Xoay -90°
                        </button>
                        <button
                          type="button"
                          className="sm"
                          onClick={() =>
                            updateEditingCrop((prev) => ({
                              ...prev,
                              rotation: ((prev.rotation + 90 + 540) % 360) - 180,
                            }))
                          }
                        >
                          ↻ Xoay +90°
                        </button>
                        <button
                          type="button"
                          className="sm"
                          onClick={() => setShowCropGrid((g) => !g)}
                        >
                          {showCropGrid ? 'Ẩn lưới' : 'Hiện lưới'}
                        </button>
                        <button
                          type="button"
                          className="sm"
                          onClick={() => updateEditingCrop(() => ({ ...DEFAULT_CROP }))}
                        >
                          Đặt lại mặc định
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              <div>
                {admPhotos.map((p, i) => (
                  <div
                    className="ph"
                    key={i}
                    style={
                      editingPhotoIdx === i
                        ? {
                            background: '#f5e6d3',
                            padding: '6px',
                            borderRadius: '8px',
                            border: '1px solid #d97706',
                          }
                        : undefined
                    }
                  >
                    <button
                      type="button"
                      className="th th-btn"
                      title="Bấm để canh chỉnh ảnh này"
                      style={p.src ? { backgroundImage: `url("${p.src}")` } : undefined}
                      onClick={() => setEditingPhotoIdx(editingPhotoIdx === i ? null : i)}
                    />
                    <input
                      value={p.caption}
                      maxLength={200}
                      placeholder="Chú thích"
                      onChange={(e) => {
                        const val = e.target.value;
                        setAdmPhotos((prev) =>
                          prev.map((item, idx) =>
                            idx === i ? { ...item, caption: val } : item
                          )
                        );
                      }}
                    />
                    <div className="ph-actions">
                      <button
                        type="button"
                        className="sm"
                        style={
                          editingPhotoIdx === i
                            ? { background: '#ffd98a', borderColor: '#b45309', fontWeight: 600 }
                            : undefined
                        }
                        onClick={() => setEditingPhotoIdx(editingPhotoIdx === i ? null : i)}
                      >
                        Canh chỉnh
                      </button>
                      <button
                        type="button"
                        className="sm"
                        onClick={() => handlePickPhoto(false, i)}
                      >
                        Đổi ảnh
                      </button>
                      <button
                        type="button"
                        className="sm"
                        disabled={admPhotos.length <= 1}
                        onClick={() => {
                          if (admPhotos.length > 1) {
                            if (editingPhotoIdx === i) {
                              setEditingPhotoIdx(null);
                            } else if (editingPhotoIdx !== null && editingPhotoIdx > i) {
                              setEditingPhotoIdx(editingPhotoIdx - 1);
                            }
                            setAdmPhotos((prev) => prev.filter((_, idx) => idx !== i));
                          }
                        }}
                      >
                        Xóa
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              <button
                type="button"
                className="sm"
                disabled={admPhotos.length >= 12}
                onClick={() => handlePickPhoto(true)}
              >
                Thêm ảnh
              </button>

              {admMsg && (
                <p
                  className="hint"
                  style={{
                    marginTop: '12px',
                    opacity: 1,
                    fontWeight: 500,
                    color: admMsg.startsWith('Đã lưu') ? '#15803d' : '#9a3412',
                  }}
                >
                  {admMsg}
                </p>
              )}

              <div className="row">
                <button
                  type="button"
                  className="sm"
                  disabled={isSaving}
                  onClick={closeModal}
                >
                  Đóng
                </button>
                <button
                  type="button"
                  className="sm"
                  disabled={isSaving}
                  onClick={handleDownloadConfigJs}
                >
                  Tải file về
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={isSaving}
                  onClick={handleSaveToFirebase}
                >
                  {isSaving ? 'Đang lưu...' : 'Lưu và cập nhật'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
