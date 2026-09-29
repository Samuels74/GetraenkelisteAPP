import { rm } from 'node:fs/promises';
import { CAMERA_DIR } from './support/env';

export default async function globalTeardown(): Promise<void> {
  await rm(CAMERA_DIR, { recursive: true, force: true });
}
