/**
 * Agent 1 response schema from backtest-news-claims/docs/AGENT.md, with the
 * predicate $defs spliced in and `$ref`s rewritten to local ones (part 3 of the
 * TODO). Generated from demo/fixtures/agent1.schema.json; the point of this
 * file is that the whole schema is ONE defineFormat() literal.
 */
import { defineFormat } from "agent-runtime-sdk";

export const Agent1Format = defineFormat({
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://example.invalid/schemas/agent1.response.schema.json",
  title: "Agent1Response",
  type: "object",
  additionalProperties: false,
  required: ["schema_version", "article", "verdict", "claims", "signal", "data_quality_flags"],
  properties: {
    schema_version: {
      const: "1.0.0",
    },
    article: {
      type: "object",
      additionalProperties: false,
      required: ["url", "published_at", "data_timestamp_present"],
      properties: {
        url: {
          type: "string",
          minLength: 1,
        },
        published_at: {
          type: ["string", "null"],
          description: "ISO-8601 UTC, null если в тексте нет",
        },
        data_timestamp_present: {
          type: "boolean",
          description: "true, если статья указывает время снимка данных (например «по состоянию на 07:20»)",
        },
        data_asof_note: {
          type: ["string", "null"],
          maxLength: 300,
        },
      },
    },
    verdict: {
      enum: ["summary_only", "forecast_not_expressible", "forecast_expressible"],
      description: "summary_only — фальсифицируемого прогноза нет; forecast_not_expressible — есть, но невычислим на свечах инструмента; forecast_expressible — есть и вычислим",
    },
    claims: {
      type: "array",
      minItems: 0,
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "evidence_quote", "kind", "asset", "direction", "falsifiable", "expressible_on_target"],
        properties: {
          id: {
            type: "string",
            pattern: "^c[0-9]{1,2}$",
          },
          evidence_quote: {
            type: "string",
            minLength: 10,
            maxLength: 600,
            description: "ДОСЛОВНАЯ подстрока статьи",
          },
          kind: {
            enum: ["forward_directional", "forward_hedged", "state_description", "advice_generic", "dated_event"],
          },
          asset: {
            enum: ["BTC", "ETH", "ALTS", "MARKET", "OTHER"],
          },
          direction: {
            enum: ["up", "down", "none"],
          },
          falsifiable: {
            type: "boolean",
          },
          expressible_on_target: {
            type: "boolean",
          },
          inexpressible_reason: {
            type: ["string", "null"],
            maxLength: 300,
            description: "обязателен при expressible_on_target = false",
          },
        },
      },
    },
    signal: {
      oneOf: [
        {
          type: "null",
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["direction", "asset", "based_on_claim_ids", "entry", "invalidation", "hard_stop", "max_holding_periods", "ttl_hours", "confidence", "rationale"],
          properties: {
            direction: {
              const: "long",
            },
            asset: {
              const: "BTC",
            },
            based_on_claim_ids: {
              type: "array",
              minItems: 1,
              maxItems: 4,
              items: {
                type: "string",
                pattern: "^c[0-9]{1,2}$",
              },
            },
            entry: {
              "$ref": "#/$defs/predicate",
            },
            invalidation: {
              "$ref": "#/$defs/predicate",
            },
            hard_stop: {
              type: "object",
              additionalProperties: false,
              required: ["mode", "value"],
              properties: {
                mode: {
                  enum: ["atr_multiple", "percent", "price"],
                },
                value: {
                  type: "number",
                  exclusiveMinimum: 0,
                },
              },
            },
            max_holding_periods: {
              type: "integer",
              minimum: 1,
              maximum: 42,
            },
            ttl_hours: {
              type: "number",
              minimum: 1,
              maximum: 48,
            },
            confidence: {
              enum: ["low", "medium"],
            },
            rationale: {
              type: "string",
              minLength: 20,
              maxLength: 800,
            },
          },
        },
      ],
    },
    data_quality_flags: {
      type: "array",
      maxItems: 8,
      items: {
        enum: ["no_publication_time", "no_data_snapshot_time", "internal_numeric_inconsistency", "number_reused_across_contexts", "logical_incoherence", "source_dates_precede_publication"],
      },
    },
  },
  allOf: [
    {
      if: {
        properties: {
          verdict: {
            const: "forecast_expressible",
          },
        },
        required: ["verdict"],
      },
      then: {
        properties: {
          signal: {
            type: "object",
          },
        },
      },
    },
    {
      if: {
        properties: {
          verdict: {
            enum: ["summary_only", "forecast_not_expressible"],
          },
        },
        required: ["verdict"],
      },
      then: {
        properties: {
          signal: {
            type: "null",
          },
        },
      },
    },
  ],
  "$defs": {
    featureName: {
      enum: ["last_price", "window_open", "window_high", "window_low", "range_pct", "ret_window_pct", "ret_15m_pct", "ret_60m_pct", "realized_vol_pct", "atr_14_pct", "vwap_window", "dist_from_vwap_pct", "volume_window", "volume_ratio_60_180", "up_bar_fraction", "max_drawdown_window_pct", "bars_available", "minutes_since_window_end"],
    },
    leaf: {
      type: "object",
      additionalProperties: false,
      required: ["feature", "op", "value"],
      properties: {
        feature: {
          "$ref": "#/$defs/featureName",
        },
        op: {
          enum: ["lt", "lte", "gt", "gte", "crosses_above", "crosses_below"],
        },
        value: {
          oneOf: [
            {
              type: "number",
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["feature"],
              properties: {
                feature: {
                  "$ref": "#/$defs/featureName",
                },
              },
            },
          ],
        },
      },
    },
    predicate: {
      oneOf: [
        {
          "$ref": "#/$defs/leaf",
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["all"],
          properties: {
            all: {
              type: "array",
              minItems: 1,
              maxItems: 6,
              items: {
                "$ref": "#/$defs/predicate",
              },
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["any"],
          properties: {
            any: {
              type: "array",
              minItems: 1,
              maxItems: 6,
              items: {
                "$ref": "#/$defs/predicate",
              },
            },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["not"],
          properties: {
            not: {
              "$ref": "#/$defs/predicate",
            },
          },
        },
      ],
    },
  },
});
