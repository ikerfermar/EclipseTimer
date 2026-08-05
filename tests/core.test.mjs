import test from "node:test";
import assert from "node:assert/strict";
import { chunkPoints, parseCoordinateInput, validateCoordinates } from "../core.mjs";

test("acepta coordenadas decimales completas con coma o punto", () => {
  assert.equal(parseCoordinateInput(" 42,5987 "), 42.5987);
  assert.equal(parseCoordinateInput("-5.5671"), -5.5671);
  assert.equal(parseCoordinateInput(".5"), 0.5);
});

test("rechaza coordenadas parcialmente numéricas o mal formadas", () => {
  ["42N", "42,5,1", "", "--5", "Infinity"].forEach((value) => {
    assert.ok(Number.isNaN(parseCoordinateInput(value)), value);
  });
});

test("valida los límites geográficos", () => {
  assert.equal(validateCoordinates(90, -180).valid, true);
  assert.equal(validateCoordinates(-90, 180).valid, true);
  assert.equal(validateCoordinates(90.001, 0).valid, false);
  assert.equal(validateCoordinates(0, -180.001).valid, false);
});

test("divide las consultas de relieve sin perder ni reordenar puntos", () => {
  const points = Array.from({ length: 183 }, (_, index) => ({ index }));
  const batches = chunkPoints(points, 100);
  assert.deepEqual(batches.map((batch) => batch.length), [100, 83]);
  assert.deepEqual(batches.flat(), points);
});
