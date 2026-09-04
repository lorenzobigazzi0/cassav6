import test from "node:test";
import assert from "node:assert/strict";
import {
  dbMutationTaskWaitMs,
  hasStrictUrgentDbMutationTask,
  hasUrgentOrStarvedDbMutationTask,
  isDbMutationTaskStarved,
  takeNextDbMutationTask,
} from "../modules/queue/db-mutation-fairness.js";

const NOW_MS = 20_000;

function task(label, priority, sequence, enqueuedAt) {
  return { label, priority, sequence, enqueuedAt };
}

test("la mutation lane riconosce un task oltre il limite di attesa", () => {
  const candidate = task("cash", 7, 1, 14_000);
  assert.equal(dbMutationTaskWaitMs(candidate, NOW_MS), 6_000);
  assert.equal(
    isDbMutationTaskStarved(candidate, {
      nowMs: NOW_MS,
      maxWaitMs: 5_000,
      urgentPriority: 5,
    }),
    true,
  );
  assert.equal(
    hasUrgentOrStarvedDbMutationTask([candidate], {
      nowMs: NOW_MS,
      maxWaitMs: 5_000,
      urgentPriority: 5,
    }),
    true,
  );
});

test("un task non urgente recente non blocca le lane specializzate", () => {
  assert.equal(
    hasUrgentOrStarvedDbMutationTask(
      [task("recent", 40, 1, 19_500)],
      { nowMs: NOW_MS, maxWaitMs: 5_000, urgentPriority: 5 },
    ),
    false,
  );
});

test("solo la priorita strettamente urgente precede lo yield domain", () => {
  const starved = task("starved", 40, 1, 10_000);
  const urgent = task("urgent", 5, 2, 19_900);

  assert.equal(
    hasStrictUrgentDbMutationTask([starved], { urgentPriority: 5 }),
    false,
  );
  assert.equal(
    hasStrictUrgentDbMutationTask([starved, urgent], { urgentPriority: 5 }),
    true,
  );
});

test("la priorita urgente resta davanti alla promozione anti-starvation", () => {
  const queue = [
    task("starved", 40, 1, 10_000),
    task("login", 2, 2, 19_900),
  ];
  const selected = takeNextDbMutationTask(queue, {
    nowMs: NOW_MS,
    maxWaitMs: 5_000,
    urgentPriority: 5,
  });
  assert.equal(selected.task.label, "login");
  assert.equal(selected.promoted, false);
  assert.equal(queue.length, 1);
});

test("a parita effettiva viene servito il task piu vecchio", () => {
  const queue = [
    task("newer-starved", 40, 8, 14_000),
    task("older-starved", 7, 3, 10_000),
  ];
  const selected = takeNextDbMutationTask(queue, {
    nowMs: NOW_MS,
    maxWaitMs: 5_000,
    urgentPriority: 5,
  });
  assert.equal(selected.task.label, "older-starved");
  assert.equal(selected.promoted, true);
  assert.equal(selected.waitMs, 10_000);
});
