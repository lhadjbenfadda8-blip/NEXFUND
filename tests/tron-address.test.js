import test from "node:test";
import assert from "node:assert/strict";
import { isValidTronAddress } from "../src/tron-address.js";

test("accepts a valid TRON Base58Check address", async () => {
  assert.equal(await isValidTronAddress("TCgnNJivezDYXMPngcffwDGKNt3tFrfN1z"), true);
});

test("rejects malformed addresses and invalid checksums", async () => {
  assert.equal(await isValidTronAddress("T123"), false);
  assert.equal(await isValidTronAddress("0x41abcdef"), false);
  assert.equal(await isValidTronAddress("TCgnNJivezDYXMPngcffwDGKNt3tFrfN1x"), false);
  assert.equal(await isValidTronAddress(""), false);
});
