import assert from "node:assert/strict";
import test from "node:test";
import { assertOperationalCatalog } from "../src/offline/catalog-contract.mjs";

const companyId = "11111111-1111-4111-8111-111111111111";
const siteId = "22222222-2222-4222-8222-222222222222";
const houseId = "33333333-3333-4333-8333-333333333333";
const lotId = "44444444-4444-4444-8444-444444444444";
const catalog = {
  company: {
    id: companyId,
    code: "TAMAGO",
    legal_name: "Tamago ficticio",
    status: "active",
  },
  sites: [{ id: siteId, code: "SEDE-A", name: "Sede A", status: "active" }],
  houses: [
    {
      id: houseId,
      site_id: siteId,
      code: "G-01",
      name: "Galpón 1",
      status: "active",
    },
  ],
  lots: [
    {
      id: lotId,
      site_id: siteId,
      house_id: houseId,
      code: "L-01",
      status: "active",
    },
  ],
};

test("authenticated operational catalog matches its schema and foreign-key hierarchy", () => {
  assert.equal(assertOperationalCatalog(catalog, companyId), catalog);
  assert.throws(
    () =>
      assertOperationalCatalog(catalog, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
    /empresa discordante/,
  );
  assert.throws(
    () =>
      assertOperationalCatalog({
        ...catalog,
        lots: [
          {
            ...catalog.lots[0],
            house_id: "55555555-5555-4555-8555-555555555555",
          },
        ],
      }),
    /relaciones discordantes/,
  );
  assert.throws(
    () => assertOperationalCatalog({ ...catalog, unexpected: true }),
    /INVALID_OPERATIONAL_CATALOG/,
  );
});
