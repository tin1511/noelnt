import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  writeBatch,
  serverTimestamp,
  onSnapshot,
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';
import { NoelConfig, PhotoItem } from './defaultConfig';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  // Avoid double-wrapping an error already formatted by handleFirestoreError
  if (error instanceof Error && error.message.startsWith('{"error":')) {
    throw error;
  }

  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'greetings', 'main'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}
testConnection();

export async function loginWithGoogle() {
  return signInWithPopup(auth, googleProvider);
}

export async function logoutGoogle() {
  return signOut(auth);
}

const GREETING_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

export function toGreetingSlug(rawInput: string): string {
  const withoutAccents = rawInput
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
  return withoutAccents
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 80);
}

export function sanitizeGreetingId(rawId: string): string {
  const cleaned = toGreetingSlug(rawId);
  if (!cleaned || !GREETING_ID_REGEX.test(cleaned)) {
    return 'main';
  }
  return cleaned.slice(0, 128);
}

export function getUserPersonalGreetingId(user: { uid: string; email?: string | null; displayName?: string | null }): string {
  // Default to a super short 3-character alphanumeric code derived from the user's UID
  return toGreetingSlug(user.uid.slice(0, 3)) || 'u1';
}

export function getInitialGreetingIdFromUrl(): string {
  const rawSearch = window.location.search.replace(/^\?/, '').trim();
  if (rawSearch) {
    const params = new URLSearchParams(window.location.search);
    const fromNamedParam = params.get('id') || params.get('u') || params.get('card');
    if (fromNamedParam) {
      return sanitizeGreetingId(fromNamedParam);
    }
    // Support ultra-short URL format like https://domain/?t or https://domain/?linh
    const firstKey = Array.from(params.keys())[0];
    if (firstKey && !firstKey.includes('=')) {
      return sanitizeGreetingId(firstKey);
    }
  }
  const hash = window.location.hash.replace(/^#\/?/, '').trim();
  if (hash) {
    return sanitizeGreetingId(hash);
  }
  const pathSeg = window.location.pathname.replace(/^\/+|\/+$/g, '').trim();
  if (pathSeg && pathSeg !== 'index.html') {
    return sanitizeGreetingId(pathSeg);
  }
  return 'main';
}

export async function fetchGreetingFromFirebase(
  greetingId = 'main'
): Promise<NoelConfig | null> {
  const validId = sanitizeGreetingId(greetingId);
  const greetingPath = `greetings/${validId}`;
  try {
    const snap = await getDoc(doc(db, 'greetings', validId));
    if (!snap.exists()) {
      return null;
    }
    const data = snap.data();
    const count = Math.max(1, Math.min(12, Number(data.photoCount) || 1));
    const photoPromises: Promise<PhotoItem | null>[] = [];

    for (let i = 0; i < count; i++) {
      const photoId = `photo_${i}`;
      const photoPath = `greetings/${validId}/photos/${photoId}`;
      photoPromises.push(
        getDoc(doc(db, 'greetings', validId, 'photos', photoId))
          .then((pSnap) => {
            if (!pSnap.exists()) return null;
            const pData = pSnap.data();
            return {
              src: String(pData.src || ''),
              caption: String(pData.caption || `Kỷ niệm ${i + 1}`),
            };
          })
          .catch((err) => {
            handleFirestoreError(err, OperationType.GET, photoPath);
          })
      );
    }

    const loadedPhotos = (await Promise.all(photoPromises)).filter(
      (p): p is PhotoItem => p !== null && Boolean(p.src)
    );

    const rawLetter = String(data.letter || '');
    const letterParagraphs = rawLetter
      .split(/\n\s*\n/)
      .map((s) => s.trim())
      .filter(Boolean);

    return {
      headline: [
        String(data.headline1 || 'Chúc Mừng'),
        String(data.headline2 || 'Giáng Sinh'),
      ],
      letter: letterParagraphs.length > 0 ? letterParagraphs : ['Giáng Sinh An Lành!'],
      sign: String(data.sign || 'Bạn của bạn'),
      bgm: typeof data.bgm === 'string' && data.bgm ? data.bgm : 'preset:we-wish-you',
      photos: loadedPhotos,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, greetingPath);
  }
}

let isSavingGreeting = false;

export function subscribeToGreeting(
  greetingId: string,
  onUpdate: (cfg: NoelConfig) => void
) {
  const validId = sanitizeGreetingId(greetingId);
  const greetingPath = `greetings/${validId}`;
  return onSnapshot(
    doc(db, 'greetings', validId),
    async (snap) => {
      // Ignore local uncommitted writes or mid-save snapshots so we only read committed server state
      if (!snap.exists() || snap.metadata.hasPendingWrites || isSavingGreeting) {
        return;
      }
      try {
        const fullCfg = await fetchGreetingFromFirebase(validId);
        if (fullCfg && fullCfg.photos.length > 0) {
          onUpdate(fullCfg);
        }
      } catch (e) {
        console.error('Failed to load updated greeting photos:', e);
      }
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, greetingPath);
    }
  );
}

export async function saveGreetingToFirebase(
  cfg: NoelConfig,
  requestedGreetingId?: string
): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('Vui lòng đăng nhập Google trước khi lưu lên Firebase.');
  }

  const defaultPersonalId = getUserPersonalGreetingId(user);
  let validId = requestedGreetingId ? sanitizeGreetingId(requestedGreetingId) : defaultPersonalId;
  // Never overwrite the shared 'main' template when a user saves their personal card
  if (!validId || validId === 'main') {
    validId = defaultPersonalId;
  }

  // Enforce schema constraints from firebase-blueprint.json
  const headline1 = (cfg.headline[0]?.normalize('NFC').trim() || 'Chúc Mừng').slice(0, 100);
  const headline2 = (cfg.headline[1]?.normalize('NFC').trim() || 'Giáng Sinh').slice(0, 100);
  const letterJoined = (
    cfg.letter
      .map((s) => s.normalize('NFC').trim())
      .filter(Boolean)
      .join('\n\n') || 'Chúc mừng Giáng Sinh!'
  ).slice(0, 10000);
  const sign = (cfg.sign?.normalize('NFC').trim() || 'Ẩn danh').slice(0, 200);
  const bgm = (cfg.bgm?.trim() || 'preset:we-wish-you').slice(0, 600000);
  const photos = cfg.photos.slice(0, 12);
  const photoCount = Math.max(1, Math.min(12, photos.length));

  isSavingGreeting = true;
  try {
    let greetingRef = doc(db, 'greetings', validId);
    let greetingPath = `greetings/${validId}`;
    let existingSnap;
    try {
      existingSnap = await getDoc(greetingRef);
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, greetingPath);
    }

    // If this slug already exists and belongs to ANOTHER user, append a short 2-char tag so we never overwrite another person's card
    if (existingSnap.exists() && existingSnap.data().ownerId !== user.uid) {
      const uidSuffix = toGreetingSlug(user.uid.slice(0, 2)) || '2';
      validId = `${validId.slice(0, 20)}${uidSuffix}`;
      greetingRef = doc(db, 'greetings', validId);
      greetingPath = `greetings/${validId}`;
      try {
        existingSnap = await getDoc(greetingRef);
      } catch (error) {
        handleFirestoreError(error, OperationType.GET, greetingPath);
      }
    }

    const previousPhotoCount = existingSnap.exists()
      ? Number(existingSnap.data().photoCount) || 0
      : 0;
    const maxCheckCount = Math.max(photoCount, previousPhotoCount, 12);

    // Check existing photo documents in parallel
    const photoRefs = Array.from({ length: maxCheckCount }, (_, i) =>
      doc(db, 'greetings', validId, 'photos', `photo_${i}`)
    );
    const photoSnaps = await Promise.all(
      photoRefs.map((ref, i) =>
        getDoc(ref).catch((error) => {
          handleFirestoreError(
            error,
            OperationType.GET,
            `greetings/${validId}/photos/photo_${i}`
          );
        })
      )
    );

    const batch = writeBatch(db);

    if (!existingSnap.exists()) {
      batch.set(greetingRef, {
        headline1,
        headline2,
        letter: letterJoined,
        sign,
        photoCount,
        bgm,
        ownerId: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      batch.update(greetingRef, {
        headline1,
        headline2,
        letter: letterJoined,
        sign,
        photoCount,
        bgm,
        updatedAt: serverTimestamp(),
      });
    }

    for (let i = 0; i < photoCount; i++) {
      const p = photos[i];
      const photoRef = photoRefs[i];
      const pSnap = photoSnaps[i];
      const caption = (p.caption?.normalize('NFC').trim() || `Kỷ niệm ${i + 1}`).slice(0, 200);
      const src = (p.src || '').slice(0, 800000);

      if (!pSnap.exists()) {
        batch.set(photoRef, {
          greetingId: validId,
          order: i,
          caption,
          src,
          ownerId: user.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } else {
        batch.update(photoRef, {
          order: i,
          caption,
          src,
          updatedAt: serverTimestamp(),
        });
      }
    }

    for (let i = photoCount; i < maxCheckCount; i++) {
      if (photoSnaps[i].exists()) {
        batch.delete(photoRefs[i]);
      }
    }

    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(
        error,
        existingSnap.exists() ? OperationType.UPDATE : OperationType.CREATE,
        greetingPath
      );
    }

    return validId;
  } finally {
    isSavingGreeting = false;
  }
}

export async function shortenUrl(longUrl: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://is.gd/create.php?format=json&url=${encodeURIComponent(longUrl)}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (data && typeof data.shorturl === 'string') {
      return data.shorturl;
    }
    return null;
  } catch {
    return null;
  }
}
