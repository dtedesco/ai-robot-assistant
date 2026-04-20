import { prisma } from "../db.js";

interface PersonRow {
  id: string;
  name: string;
  faceDescriptor: unknown;
  photoUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MatchResult {
  person: PersonRow;
  distance: number;
}

/**
 * Compute Euclidean distance between two face descriptors.
 * face-api.js produces 128-dimensional Float32 vectors.
 */
export function euclideanDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Descriptor length mismatch: ${a.length} vs ${b.length}`,
    );
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i]! - b[i]!;
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * Find the closest matching person in the database.
 * Returns null if no person matches within the threshold.
 *
 * @param descriptor - 128-dimensional face descriptor from face-api.js
 * @param threshold - Maximum distance for a match (default 0.6)
 */
export async function findClosestMatch(
  descriptor: number[],
  threshold: number = 0.6,
): Promise<MatchResult | null> {
  const persons = await prisma.person.findMany();

  let closest: MatchResult | null = null;

  for (const person of persons) {
    const stored = person.faceDescriptor as number[];
    if (!Array.isArray(stored) || stored.length !== 128) {
      continue;
    }

    const distance = euclideanDistance(descriptor, stored);

    if (distance < threshold) {
      if (!closest || distance < closest.distance) {
        closest = { person, distance };
      }
    }
  }

  return closest;
}

/**
 * Find all persons within the threshold, sorted by distance.
 */
export async function findAllMatches(
  descriptor: number[],
  threshold: number = 0.6,
): Promise<MatchResult[]> {
  const persons = await prisma.person.findMany();
  const matches: MatchResult[] = [];

  for (const person of persons) {
    const stored = person.faceDescriptor as number[];
    if (!Array.isArray(stored) || stored.length !== 128) {
      continue;
    }

    const distance = euclideanDistance(descriptor, stored);

    if (distance < threshold) {
      matches.push({ person, distance });
    }
  }

  return matches.sort((a, b) => a.distance - b.distance);
}
