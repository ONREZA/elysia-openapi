# @onreza/elysia-openapi

[Elysia](https://github.com/elysiajs/elysia) plugin to add OpenAPI documentation.

This is the ONREZA-maintained fork of `@elysia/openapi`, published as
`@onreza/elysia-openapi`.

Compared with upstream `@elysia/openapi@1.4.15`, this fork includes:

- configurable OpenAPI `3.0.x` / `3.1.x` output via `openapiVersion`
- OpenAPI 3.1 nullable schema normalization
- Date schema normalization to `string` / `date-time`
- safer ArkType fallback handling for predicates and morphs
- request-body fixes for `parse: "none"` and `ArrayBuffer`
- response headers emitted from `withHeaders`
- explicit response media types via `withContentType`, `withResponse`, and `withBinaryResponse`
- explicit request body media types via `withRequestContentType`
- schema-level OpenAPI metadata via `withOpenAPISchema` and `withDiscriminator`
- raw OpenAPI component references via `componentRef`
- local JSON Schema `$defs` hoisted into `components.schemas` with rewritten refs
- JSON-only default request body content for object schemas
- sanitized and de-duplicated default `operationId` generation for dotted, dashed, and parameterized paths
- OpenAPI operation metadata merged from `references[path][method].detail`
- deep merge of OpenAPI media type metadata without dropping generated schemas
- JSON Schema conversion context for Standard Schema/Zod/Valibot mappers
- strict schema conversion diagnostics via `strictSchemaConversion`
- nested TypeBox reference normalization
- repeated documentation page request handling
- custom absolute `specPath` handling
- WebSocket and other non-HTTP Elysia route methods excluded from OpenAPI paths
- exclusion fixes for tags, dotted API paths, and `RegExp` path filters
- `x-tagGroups` documentation type support
- `fromTypes` support for alphanumeric and digit-ending route keys, type aliases, and `import("...").TypeName` references
- type generator compiler option default merging
- Scalar theme preservation when custom CSS is not configured
- updated dependency set for the current ONREZA build/test baseline

## Installation

```bash
bun add @onreza/elysia-openapi
```

## Example

```typescript
import { Elysia, t } from 'elysia'
import { openapi } from '@onreza/elysia-openapi'

const app = new Elysia()
	.use(openapi())
	.get('/', () => 'hi', {
		response: t.String({ description: 'sample description' })
	})
	.post(
		'/json/:id',
		({ body, params: { id }, query: { name } }) => ({
			...body,
			id,
			name
		}),
		{
			params: t.Object({
				id: t.String()
			}),
			query: t.Object({
				name: t.String()
			}),
			body: t.Object({
				username: t.String(),
				password: t.String()
			}),
			response: t.Object(
				{
					username: t.String(),
					password: t.String(),
					id: t.String(),
					name: t.String()
				},
				{ description: 'sample description' }
			)
		}
	)
	.listen(3000)
```

Then go to `http://localhost:3000/openapi`.

# config

## enabled

@default true
Enable/Disable the plugin

## openapiVersion

@default '3.1.2'

OpenAPI document version to emit. Supports OpenAPI `3.0.x` and `3.1.x`.

## documentation

OpenAPI documentation information

@see https://spec.openapis.org/oas/latest.html

For OpenAPI 3.1, `documentation` can include top-level fields such as
`jsonSchemaDialect` and `webhooks`.

## exclude

Configuration to exclude paths or methods from documentation

## exclude.methods

List of methods to exclude from documentation. WebSocket and other non-HTTP
methods are always skipped because they are not valid OpenAPI Path Item
operations.

## exclude.paths

List of paths to exclude from documentation

## exclude.staticFile

@default true

Exclude static file routes from documentation

## exclude.tags

List of tags to exclude from documentation

## path

@default '/openapi'

The endpoint to expose OpenAPI documentation frontend

## provider

@default 'scalar'

OpenAPI documentation frontend between:

- [Scalar](https://github.com/scalar/scalar)
- [SwaggerUI](https://github.com/swagger-api/swagger-ui)
- null: disable frontend

## references

Additional OpenAPI reference for each endpoint

References can also merge OpenAPI operation metadata, including OpenAPI
callbacks:

```typescript
openapi({
	references: {
		'/downloads/:id': {
			get: {
				detail: {
					operationId: 'downloadFile',
					security: [{ bearerAuth: [] }],
					responses: {
						default: {
							description: 'Unexpected error'
						}
					}
				}
			}
		}
	}
})
```

## mapJsonSchema

`mapJsonSchema` converts Standard Schema-compatible validators, such as Zod or
Valibot, into JSON Schema. Mapper functions receive a second context argument:

```typescript
import { toJsonSchema } from '@valibot/to-json-schema'
import * as z from 'zod'

openapi({
	mapJsonSchema: {
		zod: (schema, context) =>
			z.toJSONSchema(schema, {
				target: context.target,
				io: context.io
			}),
		valibot: (schema, context) =>
			toJsonSchema(schema, {
				target: context.target,
				typeMode: context.typeMode
			})
	}
})
```

For OpenAPI 3.1 the target is `draft-2020-12`. For OpenAPI 3.0 the target is
`openapi-3.0`. `context.io` / `context.typeMode` is `input` for requests and
`output` for responses.

## strictSchemaConversion

Set `strictSchemaConversion: true` to throw when Standard Schema conversion
fails or returns an empty schema object. Use `'warn'` to keep generating the
document while surfacing empty conversion output.

## metadata helpers

Use `withContentType`, `withResponse`, and `withBinaryResponse` when a response
media type or response metadata cannot be inferred from the schema shape. Use
`withRequestContentType` for imports/uploads whose request body media type
should not be inferred from the route parser. Use `withOpenAPISchema` and
`withDiscriminator` for schema-level OpenAPI metadata.

Object request bodies default to `application/json`. Declare `parse` or use
`withRequestContentType` for form, multipart, CSV, binary, or vendor-specific
request media types.

```typescript
import { Elysia, t } from 'elysia'
import {
	componentRef,
	openapi,
	withBinaryResponse,
	withContentType,
	withDiscriminator,
	withOpenAPISchema,
	withRequestContentType,
	withResponse
} from '@onreza/elysia-openapi'

new Elysia()
	.use(
		openapi({
			documentation: {
				components: {
					schemas: {
						DownloadManifest: {
							type: 'object',
							required: ['url'],
							properties: {
								url: {
									type: 'string',
									format: 'uri'
								}
							}
						}
					}
				}
			}
		})
	)
	.get('/reports/csv', () => 'name\nLilith', {
		response: withContentType(t.String(), 'text/csv; charset=utf-8')
	})
	.post('/imports/csv', () => 'ok', {
		body: withRequestContentType(t.String(), 'text/csv; charset=utf-8')
	})
	.get('/reports/export', () => 'name\nLilith', {
		response: withResponse(t.String(), {
			description: 'Generated CSV export',
			contentType: 'text/csv; charset=utf-8',
			headers: {
				'x-total-rows': {
					schema: {
						type: 'integer'
					}
				}
			}
		})
	})
	.get('/invoices/pdf', () => new ArrayBuffer(0), {
		response: {
			200: withBinaryResponse('application/pdf')
		}
	})
	.get('/manifest', () => ({ url: 'https://example.com/file.pdf' }), {
		response: componentRef('DownloadManifest')
	})
	.get('/users/:id', () => ({ type: 'user', name: 'Lilith' }), {
		response: withDiscriminator(
			withOpenAPISchema(
				t.Object({
					type: t.String(),
					name: t.String()
				}),
				{
					examples: [{ type: 'user', name: 'Lilith' }]
				}
			),
			{
				propertyName: 'type'
			}
		)
	})
```

## scalar

Scalar configuration, refers to [Scalar config](https://github.com/scalar/scalar/blob/main/documentation/configuration.md)

## specPath

@default '/${path}/json'

The endpoint to expose OpenAPI specification in JSON format

## swagger

Swagger config, refers to [Swagger config](https://swagger.io/docs/open-source-tools/swagger-ui/usage/configuration/)

See [documentation](https://elysiajs.com/plugins/openapi.html) for more details.
