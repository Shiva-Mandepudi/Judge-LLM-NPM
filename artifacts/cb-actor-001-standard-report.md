# cb-actor-001 — Standard API benchmark record

Generated from the completed **Standard** run only. All values below are stored values, not estimates, except the explicitly labelled `Recorded estimated cost` column.

## Run identity

| Field | Exact value |
| --- | --- |
| Dataset subject ID | `cb-actor-001` |
| Subject | Nandamuri Taraka Rama Rao Jr. — Male — 1983-05-20, 02:29:00, Hyderabad, India, Asia/Kolkata |
| Model ID | `gpt-5.6-sol` |
| Provider endpoint | `/v1/chat/completions` |
| Dataset ID | `06cc036c-6a36-4fdb-b3d9-b6ef06ce281c` |
| Reference run ID | `35a73adf-e7d4-4d42-b62b-02566f5eeb96` |
| Standard generation run ID | `4dbe7611-18ad-4c76-bdba-96144b00d272` |
| Generated readings | 12 / 12 completed |

`cb-actor-001` is the Judge dataset subject identifier. It is not a Cosmic Guidance application `users.id`.

## Reading table

Use `Reading ID` as the exact identifier for the row in `eval_dataset_cases`. Each matching generated record is in `eval_reference_generations` under `Generation ID`.

| User ID | Model ID | Reading ID | Reading name | Variant | Generation ID | Prompt tokens | Completion tokens | Total tokens | Cached tokens | Reasoning tokens | Latency (ms) | Recorded estimated cost (USD) | Generated |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `cb-actor-001` | `gpt-5.6-sol` | `014bad71-b1b8-4363-a8a5-59c7475ff684` | Composite compatibility | brief | `3f2abbff-9de9-4a9d-8170-5db44e3b147d` | 3,933 | 1,168 | 5,101 | 0 | 144 | 21,990 | 0.039092 | Yes |
| `cb-actor-001` | `gpt-5.6-sol` | `16df9414-44b8-45ce-8243-518786bdeb34` | Composite compatibility | detailed | `3eb8d7c7-f0b0-4477-9e8c-a0d9ff002209` | 4,074 | 6,646 | 10,720 | 4,071 | 146 | 134,372 | 0.149216 | Yes |
| `cb-actor-001` | `gpt-5.6-sol` | `8575edc4-13bb-4221-b61c-94948eb807a0` | Natal chart | brief | `cb9bf90b-8250-43f4-8a4e-02bd5392f0d0` | 164,677 | 919 | 165,596 | 0 | 29 | 20,120 | 0.677088 | Yes |
| `cb-actor-001` | `gpt-5.6-sol` | `9ec7e168-faa1-4685-9e3e-fc954c6f4ee1` | Natal chart | detailed | `4fe9cf50-7ab1-494c-848e-234cf96cd912` | 164,695 | 6,616 | 171,311 | 0 | 130 | 131,176 | 0.791100 | Yes |
| `cb-actor-001` | `gpt-5.6-sol` | `2a0bf7ac-8181-4b83-b94b-43844246af80` | Numerology compatibility | brief | `d47f24f2-b43a-48ee-8c63-15032cc0460c` | 1,076 | 2,192 | 3,268 | 1,073 | 1,233 | 34,207 | 0.048144 | Yes |
| `cb-actor-001` | `gpt-5.6-sol` | `84a08cac-685f-47f3-a2d4-67fdd4402ac0` | Numerology compatibility | detailed | `ced0ab25-b161-4e41-a236-147714ce4992` | 1,061 | 4,929 | 5,990 | 0 | 93 | 97,319 | 0.102824 | Yes |
| `cb-actor-001` | `gpt-5.6-sol` | `af4e399f-9fae-4342-8743-f16d8e9130b1` | Synastry compatibility | brief | `64c8cf07-26ca-457d-9707-44a12179bb9b` | 5,392 | 895 | 6,287 | 0 | 61 | 16,844 | 0.039468 | Yes |
| `cb-actor-001` | `gpt-5.6-sol` | `604fc74f-9a4d-4736-887b-2692fde2b695` | Synastry compatibility | detailed | `cee22bff-74c0-4d59-ba33-2fec821e74e3` | 5,551 | 6,525 | 12,076 | 0 | 117 | 126,930 | 0.152704 | Yes |
| `cb-actor-001` | `gpt-5.6-sol` | `c58107d2-db13-4872-8f7c-65a16d1a620e` | Tarot reading | brief | `e9071de5-9fd3-4321-9619-28595c55b8d2` | 1,266 | 1,239 | 2,505 | 0 | 70 | 23,382 | 0.029844 | Yes |
| `cb-actor-001` | `gpt-5.6-sol` | `c0480149-9683-44a8-982b-28a8da6ff5f4` | Tarot reading | detailed | `6e52e4ec-f11f-423e-83fd-0b45e4aa3e3b` | 1,085 | 3,124 | 4,209 | 0 | 148 | 64,032 | 0.066820 | Yes |
| `cb-actor-001` | `gpt-5.6-sol` | `a38e5492-12bd-40f7-8f7e-a5dac0524901` | Transit reading (2026-08-24) | brief | `baeb9d66-d47c-4c28-9be1-ca48005cd164` | 206,948 | 1,102 | 208,050 | 0 | 130 | 20,729 | 0.849832 | Yes |
| `cb-actor-001` | `gpt-5.6-sol` | `e373368b-d495-4f57-b59d-73b81e053f3c` | Transit reading (2026-08-24) | detailed | `934e5d46-bf48-43ef-86bc-8b7d55771fb6` | 207,062 | 6,409 | 213,471 | 207,059 | 148 | 126,582 | 0.956428 | Yes |

## Totals for the Standard run

| Readings | Prompt tokens | Completion tokens | Total tokens | Average latency (ms) | Recorded estimated cost (USD) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 12 | 766,820 | 41,764 | 808,584 | 68,140 | 3.902560 |

## Reading fact table

The full system prompt is intentionally referenced, not copied, because the exact request payloads are already preserved in the database and several payloads are very large. This avoids creating a second, divergent copy. For every row, the exact text is at `eval_reference_generations.provider_metadata -> requestBody -> messages[0] -> content`.

| Reading ID | Reading name | Model (LLM) | System prompt source | System prompt tokens | System prompt SHA-256 |
| --- | --- | --- | --- | ---: | --- |
| `014bad71-b1b8-4363-a8a5-59c7475ff684` | Composite compatibility — brief | `gpt-5.6-sol` | `3f2abbff-9de9-4a9d-8170-5db44e3b147d` request body, system message | 883 | `3ab9143287d8838821b9ba8e94a19d8417a3e765b419f13eba2511114e778245` |
| `16df9414-44b8-45ce-8243-518786bdeb34` | Composite compatibility — detailed | `gpt-5.6-sol` | `3eb8d7c7-f0b0-4477-9e8c-a0d9ff002209` request body, system message | 997 | `0e2ab9d6d9068596f1b4b5cd9a695e831ac737fb260993aee08872dc67c8a1a1` |
| `8575edc4-13bb-4221-b61c-94948eb807a0` | Natal chart — brief | `gpt-5.6-sol` | `cb9bf90b-8250-43f4-8a4e-02bd5392f0d0` request body, system message | 764 | `c26db4d640be788a37db1922d5ebf17808d9632a24e000ed79586a3ea959c9e4` |
| `9ec7e168-faa1-4685-9e3e-fc954c6f4ee1` | Natal chart — detailed | `gpt-5.6-sol` | `4fe9cf50-7ab1-494c-848e-234cf96cd912` request body, system message | 794 | `b9a8ebd803957fb6ada0968ffcd36698513040c1eaa630dff45d95f13a8b7a4a` |
| `2a0bf7ac-8181-4b83-b94b-43844246af80` | Numerology compatibility — brief | `gpt-5.6-sol` | `d47f24f2-b43a-48ee-8c63-15032cc0460c` request body, system message | 698 | `45df04a5711994527aae0b3d38cd2f3aa9dd3e6299402d3e3fa134648bcca23c` |
| `84a08cac-685f-47f3-a2d4-67fdd4402ac0` | Numerology compatibility — detailed | `gpt-5.6-sol` | `ced0ab25-b161-4e41-a236-147714ce4992` request body, system message | 681 | `1427b122fa74725c24840961dbd3ca02d113fc3cd39cd6d594dcd23f79ebb630` |
| `af4e399f-9fae-4342-8743-f16d8e9130b1` | Synastry compatibility — brief | `gpt-5.6-sol` | `64c8cf07-26ca-457d-9707-44a12179bb9b` request body, system message | 825 | `b98e262d9cbcbc27e3f1bb9e7c0091b28daf9d1e2d5a2bb5ee2f902770556b6c` |
| `604fc74f-9a4d-4736-887b-2692fde2b695` | Synastry compatibility — detailed | `gpt-5.6-sol` | `cee22bff-74c0-4d59-ba33-2fec821e74e3` request body, system message | 939 | `5e120f838abc86aa91a48226522796b490c6c9176157d066e053b5689e68e7f5` |
| `c58107d2-db13-4872-8f7c-65a16d1a620e` | Tarot reading — brief | `gpt-5.6-sol` | `e9071de5-9fd3-4321-9619-28595c55b8d2` request body, system message | 675 | `0a0badffaa8a0ecf73e164790fe24ad225ed9312f4379e70df39849ec6e92f18` |
| `c0480149-9683-44a8-982b-28a8da6ff5f4` | Tarot reading — detailed | `gpt-5.6-sol` | `6e52e4ec-f11f-423e-83fd-0b45e4aa3e3b` request body, system message | 669 | `cd51d1db1933e7e2711e839da02c71bd1fc8db330edea6f018d0cdd6acd32359` |
| `a38e5492-12bd-40f7-8f7e-a5dac0524901` | Transit reading — brief | `gpt-5.6-sol` | `baeb9d66-d47c-4c28-9be1-ca48005cd164` request body, system message | 726 | `f9fccbc0637fb0fdbca3bdeec5635428466cbb36e9a2b93eaa83efb4ce1a9e96` |
| `e373368b-d495-4f57-b59d-73b81e053f3c` | Transit reading — detailed | `gpt-5.6-sol` | `934e5d46-bf48-43ef-86bc-8b7d55771fb6` request body, system message | 804 | `fa410751822d5240e97dc9f4a0641fbed97dfa4cd02e6d88ebad8a3864d75744` |

## Exact raw-data locations

| Spreadsheet field | Exact source of truth |
| --- | --- |
| User payload | `eval_dataset_subjects.subject_data` for the subject; case-specific input snapshot in `eval_dataset_cases.input` |
| Full request, including system and user prompts | `eval_reference_generations.provider_metadata -> requestBody` |
| LLM response raw | `eval_reference_generations.raw_output` |
| Parsed reading output | `eval_reference_generations.parsed_output` |
| Token and latency values | `eval_reference_generations.tokens_prompt`, `tokens_completion`, `tokens_total`, `tokens_cached`, `tokens_reasoning`, `latency_ms` |
| Per-reading hash integrity check | `eval_dataset_cases.input_checksum`, plus prompt/response hashes in `eval_reference_generations.provider_metadata` |

The request and response payload are not duplicated in this report. They are preserved once in the Judge DB as the audit record used to submit the exact same request to Batch later; copying them here would create a second source of truth.

## Model cost fact table

| Model ID | Model name | Tier | Input / 1M tokens | Cached input / 1M tokens | Output / 1M tokens |
| --- | --- | --- | ---: | ---: | ---: |
| `gpt-5.6-sol` | GPT-5.6 Sol | Standard | $4.00 | $0.40 | $20.00 |

These are the currently published text-token prices for GPT-5.6 Sol, not an invoice total. The recorded Standard-run cost above is calculated using `$4.00 / 1M` prompt tokens and `$20.00 / 1M` completion tokens; it does **not** apply a cached-input discount. The values are from the official OpenAI GPT-5.6 Sol model page: <https://developers.openai.com/api/docs/models/gpt-5.6-sol>.

No Batch or Fast Mode price row is included because this report is strictly for the completed Standard run and no Batch output has been imported yet.
