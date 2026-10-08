import { ConfigSchema, type A7ProviderConfig } from "@core/validations/config";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, test } from "bun:test";
import { selectMerchants, type Listing } from "./marketplace";

const model = "gpt-6-luna";
const provider: A7ProviderConfig = {
  type: "a7",
  name: "a7",
  baseUrl: "https://marketplace.example",
  systemAccessToken: "test-placeholder",
  userId: 1,
};

function listing(channelId: number, overrides: Partial<Listing> = {}): Listing {
  return {
    channel_id: channelId,
    listing_id: channelId + 10000,
    supplier_name: "merchant",
    channel_name: "channel",
    description: "",
    smart_routing_labels: [],
    model_name: model,
    charge_type: "per_token",
    listing_availability: 1,
    supplier_channel_disabled: false,
    user_channel_disabled: false,
    authenticity_guaranteed: true,
    input_price_micros: 10000,
    output_price_micros: 50000,
    recent_success_rate: 10000,
    sample_count: 30,
    ...overrides,
  };
}

function candidates(
  rows: Listing[],
  overrides: Partial<A7ProviderConfig> = {},
  blacklist: string[] = [],
  modelName = model,
) {
  return selectMerchants(
    modelName,
    rows,
    { ...provider, ...overrides },
    1,
    blacklist,
  ).map((row) => row.channel_id);
}

describe("A7 merchant allowlist", () => {
  test("omitted allowlist preserves automatic selection and price order", () => {
    expect(
      candidates([listing(4482), listing(4000, { input_price_micros: 1000 })]),
    ).toEqual([4000, 4482]);
  });

  test("uses channel IDs, excluding cheaper outside merchants and listing IDs", () => {
    expect(
      candidates(
        [
          listing(4482),
          listing(4000, { listing_id: 4482, input_price_micros: 1000 }),
        ],
        { merchantAllowlist: { [model]: [4482] } },
      ),
    ).toEqual([4482]);
  });

  test("sorts multiple allowed merchants by price rather than allowlist order", () => {
    expect(
      candidates(
        [
          listing(4482),
          listing(4000, { input_price_micros: 1000 }),
          listing(3000, { input_price_micros: 100 }),
        ],
        { merchantAllowlist: { [model]: [4482, 4000] } },
      ),
    ).toEqual([4000, 4482]);
  });

  test("matches model patterns without case sensitivity", () => {
    expect(
      candidates(
        [listing(4482), listing(4000)],
        {
          merchantAllowlist: { "GPT-*": [4482] },
        },
        [],
        "GPT-6-LUNA",
      ),
    ).toEqual([4482]);
  });

  test("first matching pattern wins, ahead of default", () => {
    expect(
      candidates([listing(4482), listing(4000)], {
        merchantAllowlist: {
          default: [4000],
          "gpt-*": [4482],
          [model]: [4000],
        },
      }),
    ).toEqual([4482]);
  });

  test("uses default for unmatched models", () => {
    expect(
      candidates([listing(4482), listing(4000)], {
        merchantAllowlist: { "claude-*": [4000], default: [4482] },
      }),
    ).toEqual([4482]);
  });

  test("unmatched models without default keep automatic selection", () => {
    expect(
      candidates([listing(4482), listing(4000)], {
        merchantAllowlist: { "claude-*": [4482] },
      }),
    ).toEqual([4482, 4000]);
  });

  test("empty model rule overrides a nonempty default", () => {
    expect(
      candidates([listing(4482)], {
        merchantAllowlist: { [model]: [], default: [4482] },
      }),
    ).toEqual([]);
  });

  test("empty default permits no unmatched merchants", () => {
    expect(
      candidates([listing(4482)], {
        merchantAllowlist: { "claude-*": [4482], default: [] },
      }),
    ).toEqual([]);
  });

  test("missing allowed merchants do not trigger outside-list fallback", () => {
    expect(
      candidates([listing(4000)], {
        merchantAllowlist: { [model]: [4482] },
      }),
    ).toEqual([]);
  });

  const ineligible: [string, Partial<Listing>][] = [
    ["unavailable", { listing_availability: 0 }],
    ["supplier-disabled", { supplier_channel_disabled: true }],
    ["user-disabled", { user_channel_disabled: true }],
    ["not per-token", { charge_type: "per_request" }],
    ["invalid price", { input_price_micros: 0 }],
    ["below success floor", { recent_success_rate: 5000 }],
    ["not guaranteed", { authenticity_guaranteed: false }],
    ["above sell ceiling", { output_price_micros: 1000000 }],
  ];
  for (const [reason, overrides] of ineligible) {
    test(`does not bypass ${reason} or fall back to other merchants`, () => {
      expect(
        candidates([listing(4482, overrides), listing(4000)], {
          merchantAllowlist: { [model]: [4482] },
          minSuccessRate: 9000,
          guaranteedOnly: true,
        }),
      ).toEqual([]);
    });
  }

  for (const blacklist of [["a7/4482"], ["a7/4482/gpt-*"], ["a7/merchant"]]) {
    test(`blacklist ${blacklist[0]} takes precedence`, () => {
      expect(
        candidates(
          [listing(4482), listing(4000)],
          {
            merchantAllowlist: { [model]: [4482] },
          },
          blacklist,
        ),
      ).toEqual([]);
    });
  }
});

describe("A7 merchant allowlist configuration validation", () => {
  function valid(merchantAllowlist: unknown) {
    return Value.Check(ConfigSchema, {
      target: {
        baseUrl: "http://localhost:3000",
        systemAccessToken: "test-placeholder",
        userId: 1,
      },
      providers: [{ ...provider, merchantAllowlist }],
    });
  }

  test("accepts optional, empty, exact, wildcard and default rules", () => {
    for (const allowlist of [
      undefined,
      {},
      { [model]: [4482, 4000], "claude-*": [], default: [4134] },
    ])
      expect(valid(allowlist)).toBe(true);
  });

  test("rejects malformed rules and nonpositive, fractional, unsafe or repeated IDs", () => {
    for (const allowlist of [
      [4482],
      { [model]: 4482 },
      { [model]: ["4482"] },
      { [model]: [0] },
      { [model]: [-1] },
      { [model]: [1.5] },
      { [model]: [Number.MAX_SAFE_INTEGER + 1] },
      { [model]: [4482, 4482] },
    ])
      expect(valid(allowlist)).toBe(false);
  });
});
