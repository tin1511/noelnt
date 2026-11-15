# Security Specification (`security_spec.md`)

## 1. Data Invariants

1. **Global Default Deny**: Any path not explicitly matched in `/databases/{database}/documents` is unconditionally denied (`allow read, write: if false;`).
2. **GreetingConfig Ownership & Integrity (`/greetings/{greetingId}`)**:
   - Document ID `greetingId` must match `^[a-zA-Z0-9_\-]+$` and be at most 128 characters.
   - Public visitors can `get` a specific greeting card by ID (`main`), while `list` is strictly forbidden (`allow list: if false;`).
   - Only authenticated users with a verified email (`request.auth.token.email_verified == true`) can create a greeting document, and `incoming().ownerId` must equal `request.auth.uid`.
   - `createdAt` and `updatedAt` must equal `request.time` on creation; `createdAt` and `ownerId` are immutable on update, and `updatedAt` must equal `request.time`.
   - Only the owner (`existing().ownerId == request.auth.uid`) or a verified administrator (`isAdmin()`) may update or delete a greeting configuration.
3. **TreePhoto Relational Sync (`/greetings/{greetingId}/photos/{photoId}`)**:
   - A `TreePhoto` cannot exist or be accessed unless its parent `/greetings/{greetingId}` document exists (Master Gate).
   - `incoming().greetingId` must match the path `{greetingId}` and remain immutable.
   - Only the parent greeting's owner or a verified administrator (`isAdmin()`) may create, update, or delete photos under `/greetings/{greetingId}/photos/{photoId}`.
   - All strings (`caption`, `src`, `ownerId`, `greetingId`) have strict `.size()` bounds.
4. **Admin Collection (`/admins/{adminId}`)**:
   - Strictly read-only for the matching authenticated user or existing admin; client writes (`create`, `update`, `delete`) are forbidden (`if false`) to prevent privilege escalation or self-assigned roles.

## 2. The "Dirty Dozen" Payloads

1. **Unauthenticated Write**: Creating `/greetings/main` with `auth == null`.
2. **Unverified Email Spoof**: Creating `/greetings/main` with `email: "dthong.design2016@gmail.com"` but `email_verified: false`.
3. **Identity Spoofing on Create**: Creating `/greetings/main` where `ownerId != request.auth.uid`.
4. **Shadow Field Injection on Create**: Creating `/greetings/main` with an extra field `isSuperAdmin: true`.
5. **Shadow Field Injection on Update**: Updating `/greetings/main` with an extra field `hacked: "yes"`.
6. **Immutable Field Mutation (`ownerId`)**: Updating `/greetings/main` to change `ownerId` to another user.
7. **Immutable Field Mutation (`createdAt`)**: Updating `/greetings/main` with a modified `createdAt` timestamp.
8. **Future/Past Client Timestamp Forgery**: Creating or updating `/greetings/main` where `updatedAt != request.time`.
9. **Resource Exhaustion / Oversized Payload**: Updating `/greetings/main` with `headline1` exceeding 100 chars or `photoCount` outside `[1, 12]`.
10. **Orphaned Subcollection Write**: Creating `/greetings/nonexistent/photos/photo_0` when `/greetings/nonexistent` does not exist.
11. **Cross-Tenant Subcollection Write**: User B attempting to create/update `/greetings/main/photos/photo_0` when User A owns `/greetings/main`.
12. **Self-Assigned Admin Escalation**: Authenticated user attempting to create `/admins/{uid}` with `{ role: "admin" }`.
