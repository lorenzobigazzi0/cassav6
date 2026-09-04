import assert from "node:assert/strict";
import test from "node:test";

import {
  ROUTE_ADVERTISEMENT_KINDS,
  ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET,
  ROUTE_ADVERTISEMENT_WIRE_BYTES,
  InMemoryRouteAdvertisementSequenceStoreV1,
  RouteAdvertisementError,
  RouteAdvertisementPublisherV1,
  batteryBucketV1,
  decodeRouteAdvertisementV1,
  encodeRouteAdvertisementV1,
  queueDepthBucketV1,
  serverRttBucketV1
} from "../dist/routing/RouteAdvertisementV1.js";

test("route advertisement has a frozen 12-byte privacy-safe wire", () => {
  const input = {
    canReachServer: true,
    routeKind: ROUTE_ADVERTISEMENT_KINDS.LAN,
    serverRttBucket: 2,
    routeAgeSeconds: 5,
    queueDepthBucket: 4,
    batteryBucket: 8,
    sequence: 1
  };
  const wire = encodeRouteAdvertisementV1(input);
  assert.equal(wire.length, ROUTE_ADVERTISEMENT_WIRE_BYTES);
  assert.equal(wire.toString("hex"), "010102020005040800000001");
  assert.deepEqual(decodeRouteAdvertisementV1(wire), input);
  assert.equal(wire.toString("utf8").includes("node"), false);
});

test("bucket functions cover boundaries and explicit unknown values", () => {
  assert.deepEqual(
    [0, 10, 11, 25, 26, 50, 51, 100, 101, 250, 251, 500, 501, 1_000, 1_001]
      .map(serverRttBucketV1),
    [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7]
  );
  assert.equal(serverRttBucketV1(null), ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 8, 16, 32_768].map(queueDepthBucketV1),
    [0, 1, 2, 2, 3, 4, 5, 15]
  );
  assert.deepEqual(
    [0, 9.9, 10, 50, 99.9, 100].map(batteryBucketV1),
    [0, 0, 1, 5, 9, 10]
  );
  assert.equal(batteryBucketV1(null), ROUTE_ADVERTISEMENT_UNKNOWN_BUCKET);
});

test("B9 forbids claiming multihop reachability and invalid RTT state", () => {
  const base = {
    canReachServer: true,
    routeKind: ROUTE_ADVERTISEMENT_KINDS.LAN,
    serverRttBucket: 1,
    routeAgeSeconds: 0,
    queueDepthBucket: 0,
    batteryBucket: 10,
    sequence: 1
  };
  assert.throws(
    () =>
      encodeRouteAdvertisementV1({
        ...base,
        routeKind: ROUTE_ADVERTISEMENT_KINDS.BLE_DIRECT
      }),
    (error) =>
      error instanceof RouteAdvertisementError &&
      error.code === "MULTIHOP_NOT_ALLOWED"
  );
  assert.throws(
    () =>
      encodeRouteAdvertisementV1({
        ...base,
        canReachServer: false
      }),
    (error) =>
      error instanceof RouteAdvertisementError &&
      error.code === "INVALID_ROUTE_STATE"
  );
  const reserved = encodeRouteAdvertisementV1(base);
  reserved[1] = 2;
  assert.throws(
    () => decodeRouteAdvertisementV1(reserved),
    (error) =>
      error instanceof RouteAdvertisementError &&
      error.code === "INVALID_ROUTE_FLAGS"
  );
});

test("publisher refreshes no slower than five seconds and fails on clock regression", () => {
  const publisher = new RouteAdvertisementPublisherV1(5_000);
  const input = {
    nowEpochMs: 100_000,
    canReachServer: true,
    routeKind: ROUTE_ADVERTISEMENT_KINDS.WIFI,
    serverRttMs: 20,
    lastRouteChangeAtEpochMs: 95_000,
    queueDepth: 3,
    batteryPercent: 75
  };
  assert.equal(decodeRouteAdvertisementV1(publisher.build(input)).sequence, 1);
  assert.equal(publisher.build({ ...input, nowEpochMs: 104_999 }), null);
  assert.equal(
    decodeRouteAdvertisementV1(
      publisher.build({ ...input, nowEpochMs: 105_000 })
    ).sequence,
    2
  );
  assert.equal(
    decodeRouteAdvertisementV1(
      publisher.build({ ...input, nowEpochMs: 105_001, force: true })
    ).sequence,
    3
  );
  assert.throws(
    () => publisher.build({ ...input, nowEpochMs: 105_000 }),
    (error) =>
      error instanceof RouteAdvertisementError && error.code === "CLOCK_REGRESSION"
  );
});

test("publisher resumes its persisted sequence after recreation", () => {
  const sequenceStore = new InMemoryRouteAdvertisementSequenceStoreV1(40);
  const input = {
    nowEpochMs: 100_000,
    canReachServer: true,
    routeKind: ROUTE_ADVERTISEMENT_KINDS.WIFI,
    serverRttMs: 20,
    lastRouteChangeAtEpochMs: 95_000,
    queueDepth: 0,
    batteryPercent: 75
  };
  const first = new RouteAdvertisementPublisherV1(5_000, sequenceStore);
  assert.equal(decodeRouteAdvertisementV1(first.build(input)).sequence, 41);
  const reopened = new RouteAdvertisementPublisherV1(5_000, sequenceStore);
  assert.equal(decodeRouteAdvertisementV1(reopened.build(input)).sequence, 42);
});
