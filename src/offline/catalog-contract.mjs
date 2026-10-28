import validate from "../../.generated/operational-catalog-validator.mjs";

export function assertOperationalCatalog(value, expectedCompanyId) {
  if (!validate(value))
    throw new Error(
      `INVALID_OPERATIONAL_CATALOG: ${validate.errors?.[0]?.instancePath || "/"}`,
    );
  if (expectedCompanyId && value.company.id !== expectedCompanyId)
    throw new Error("INVALID_OPERATIONAL_CATALOG: empresa discordante.");

  const siteIds = new Set(value.sites.map(({ id }) => id));
  const houseIds = new Set(value.houses.map(({ id }) => id));
  const lotIds = new Set(value.lots.map(({ id }) => id));
  if (
    siteIds.size !== value.sites.length ||
    houseIds.size !== value.houses.length ||
    lotIds.size !== value.lots.length ||
    value.houses.some(({ site_id }) => !siteIds.has(site_id)) ||
    value.lots.some(
      ({ site_id, house_id }) =>
        !siteIds.has(site_id) || !houseIds.has(house_id),
    )
  )
    throw new Error("INVALID_OPERATIONAL_CATALOG: relaciones discordantes.");
  return value;
}
