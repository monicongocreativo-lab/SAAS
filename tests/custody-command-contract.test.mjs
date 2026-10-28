import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

const schema = JSON.parse(
  readFileSync(
    new URL(
      "../contracts/custody-case-command.v1.schema.json",
      import.meta.url,
    ),
  ),
);
const validate = new Ajv2020({ strict: true }).compile(schema);
function command(action, details) {
  return {
    schema_version: 1,
    command_id: "d2000000-0000-4000-8000-000000000003",
    company_id: "c2000000-0000-4000-8000-000000000001",
    incident_id: "d1000000-0000-4000-8000-000000000001",
    expected_revision: 2,
    action,
    details,
  };
}
test("custody command v1 admits only explicit evidence, submission and nonfinal review", () => {
  for (const [action, details] of [
    [
      "add_evidence",
      { kind: "missing", reference: null, notes: "Falta acta de entrega" },
    ],
    ["submit", { summary: "Investigación presentada" }],
    ["request_evidence", { reason: "Falta antecedente de entrega" }],
    ["continue_investigation", { reason: "Causa aún desconocida" }],
  ])
    assert.equal(
      validate(command(action, details)),
      true,
      JSON.stringify(validate.errors),
    );
});
test("custody commands reject fabricated approval, actor claims and invalid details", () => {
  const valid = command("request_evidence", { reason: "Aportar evidencia" });
  for (const invalid of [
    { ...valid, action: "authorize_loss" },
    { ...valid, action: "resolve" },
    { ...valid, actor_id: valid.command_id },
    { ...valid, details: { reason: "Aportar evidencia", status: "resolved" } },
    { ...valid, details: { reason: "   " } },
    { ...valid, expected_revision: -1 },
    { ...valid, expected_revision: 1.5 },
    { ...valid, expected_revision: "2" },
    { ...valid, schema_version: 2 },
  ])
    assert.equal(validate(invalid), false, JSON.stringify(invalid));
});
