import { describe, it, expect } from 'bun:test'
import { AnyElysia, Elysia, t } from 'elysia'

import {
	componentRef,
	toOpenAPISchema,
	withBinaryResponse,
	withContentType,
	withDiscriminator,
	withHeaders,
	withOpenAPISchema,
	withRequestContentType,
	withResponse
} from '../../src/openapi'
import { z } from 'zod'
import { type } from 'arktype'

const is = <T extends AnyElysia>(
	app: T,
	schema: {
		paths: Record<string, any>
		components: Record<string, any>
	}
) => {
	expect(JSON.parse(JSON.stringify(toOpenAPISchema(app)))).toEqual(schema)

	expect(JSON.parse(JSON.stringify(toOpenAPISchema(app)))).not.toEqual({
		...schema,
		paths: {
			...schema.paths,
			'/non-existent-path': {}
		}
	})
}

describe('OpenAPI > toOpenAPISchema', () => {
	it('work', () => {
		const app = new Elysia().get('/user', () => 'hello')

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/user': {
					get: {
						operationId: 'getUser'
					}
				}
			}
		})
	})

	it('handle params', () => {
		const app = new Elysia().get('/user/:user', () => 'hello', {
			params: t.Object({
				user: t.Number()
			})
		})

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/user/{user}': {
					get: {
						operationId: 'getUserByUser',
						parameters: [
							{
								in: 'path',
								name: 'user',
								required: true,
								schema: {
									type: 'number'
								}
							}
						]
					}
				}
			}
		})
	})

	it('handle headers', () => {
		const app = new Elysia().get('/user', () => 'hello', {
			headers: t.Object({
				'x-user-name': t.Literal('Lilith')
			})
		})

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/user': {
					get: {
						operationId: 'getUser',
						parameters: [
							{
								in: 'header',
								name: 'x-user-name',
								required: true,
								schema: {
									type: 'string',
									const: 'Lilith'
								}
							}
						]
					}
				}
			}
		})
	})

	it('handle query', () => {
		const app = new Elysia().get('/user', () => 'hello', {
			query: t.Object({
				name: t.Literal('Lilith')
			})
		})

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/user': {
					get: {
						operationId: 'getUser',
						parameters: [
							{
								in: 'query',
								name: 'name',
								required: true,
								schema: {
									type: 'string',
									const: 'Lilith'
								}
							}
						]
					}
				}
			}
		})
	})

	it('handle cookie', () => {
		const app = new Elysia().get('/user', () => 'hello', {
			cookie: t.Object({
				name: t.Literal('Lilith')
			})
		})

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/user': {
					get: {
						operationId: 'getUser',
						parameters: [
							{
								in: 'cookie',
								name: 'name',
								required: true,
								schema: {
									type: 'string',
									const: 'Lilith'
								}
							}
						]
					}
				}
			}
		})
	})

	it('handle body', () => {
		const app = new Elysia().post('/user', () => 'hello', {
			body: t.Object({
				name: t.Literal('Lilith')
			})
		})

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/user': {
					post: {
						operationId: 'postUser',
						requestBody: {
							content: {
								'application/json': {
									schema: {
										properties: {
											name: {
												const: 'Lilith',
												type: 'string'
											}
											},
											required: ['name'],
											type: 'object'
										}
									},
								},
								required: true
							}
						}
				}
			}
		})
	})

	it('handle arrayBuffer request body', () => {
		const app = new Elysia().post('/upload', () => 'ok', {
			parse: 'arrayBuffer',
			body: t.Any({
				description: 'Binary file data'
			})
		})

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/upload': {
					post: {
						operationId: 'postUpload',
						requestBody: {
							description: 'Binary file data',
							content: {
								'application/octet-stream': {
									schema: {
										description: 'Binary file data'
									}
								}
							},
							required: true
						}
					}
				}
			}
		})
	})

	it('uses explicit request body content type metadata', () => {
		const app = new Elysia().post('/imports/csv', () => 'ok', {
			body: withRequestContentType(
				t.String({
					description: 'CSV payload'
				}),
				'text/csv; charset=utf-8'
			)
		})

		const requestBody = JSON.parse(JSON.stringify(toOpenAPISchema(app)))
			.paths['/imports/csv'].post.requestBody

		expect(requestBody).toEqual({
			description: 'CSV payload',
			required: true,
			content: {
				'text/csv; charset=utf-8': {
					schema: {
						description: 'CSV payload',
						type: 'string'
					}
				}
			}
		})
	})

	it('falls back to schema-inferred request content for custom parsers', () => {
		const app = new Elysia().post(
			'/custom-parse',
			({ body }) => body,
			{
				body: z.object({
					name: z.string()
				}),
				parse: async ({ request }) =>
					JSON.parse(await request.text())
			}
		)

		const requestBody = JSON.parse(
			JSON.stringify(
				toOpenAPISchema(app, undefined, undefined, {
					zod: z.toJSONSchema
				})
			)
		).paths['/custom-parse'].post.requestBody

		expect(requestBody.content).not.toEqual({})
		expect(requestBody.content['application/json'].schema).toEqual({
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			type: 'object',
			properties: {
				name: { type: 'string' }
			},
			required: ['name']
		})
	})

	it('uses explicit request content type metadata on Zod schemas', () => {
		const app = new Elysia().post('/custom-json', () => 'ok', {
			body: withRequestContentType(
				z.object({
					name: z.string()
				}),
				'application/vnd.example+json'
			),
			parse: async ({ request }) => JSON.parse(await request.text())
		})

		const requestBody = JSON.parse(
			JSON.stringify(
				toOpenAPISchema(app, undefined, undefined, {
					zod: z.toJSONSchema
				})
			)
		).paths['/custom-json'].post.requestBody

		expect(Object.keys(requestBody.content)).toEqual([
			'application/vnd.example+json'
		])
		const explicitSchema =
			requestBody.content['application/vnd.example+json'].schema

		expect(explicitSchema.properties.name).toEqual({ type: 'string' })
	})

	it('passes conversion context to mapJsonSchema functions', () => {
		const calls: any[] = []
		const app = new Elysia().post('/context', () => ({ ok: true }), {
			body: z.object({
				name: z.string()
			}),
			response: z.object({
				ok: z.boolean()
			})
		})

		const schema = JSON.parse(
			JSON.stringify(
				toOpenAPISchema(
					app,
					undefined,
					undefined,
					{
						zod: (schema, context) => {
							calls.push({ ...context })

							return z.toJSONSchema(schema, {
								target: context.target
							})
						}
					},
					'3.0.3'
				)
			)
		)

		expect(calls.map(({ io }) => io).sort()).toEqual([
			'input',
			'output'
		])
		expect(calls.every(({ target }) => target === 'openapi-3.0')).toBe(true)
		expect(calls.every(({ typeMode, io }) => typeMode === io)).toBe(true)
		expect(
			schema.paths['/context'].post.requestBody.content[
				'application/json'
			].schema.properties.name
		).toEqual({ type: 'string' })
		expect(
			schema.paths['/context'].post.responses['200'].content[
				'application/json'
			].schema.properties.ok
		).toEqual({ type: 'boolean' })
	})

	it('uses the JSON Schema 2020-12 target for OpenAPI 3.2', () => {
		const calls: any[] = []
		const app = new Elysia().post('/context-32', () => 'ok', {
			body: z.object({ name: z.string() })
		})

		toOpenAPISchema(
			app,
			undefined,
			undefined,
			{
				zod: (schema, context) => {
					calls.push({ ...context })
					return z.toJSONSchema(schema, { target: context.target })
				}
			},
			'3.2.0'
		)

		expect(calls).toHaveLength(1)
		expect(calls[0]).toMatchObject({
			openapiVersion: '3.2.0',
			target: 'draft-2020-12'
		})
	})

	it('uses input conversion for query defaults', () => {
		const app = new Elysia().get('/search', () => 'ok', {
			query: z.object({
				page: z.number().default(1)
			})
		})

		const schema = JSON.parse(
			JSON.stringify(
				toOpenAPISchema(app, undefined, undefined, {
					zod: (schema, context) =>
						z.toJSONSchema(schema, {
							io: context.io,
							target: context.target
						})
				})
			)
		)

		expect(schema.paths['/search'].get.parameters).toEqual([
			{
				name: 'page',
				in: 'query',
				required: false,
				schema: {
					default: 1,
					type: 'number'
				}
			}
		])
	})

	it('hoists embedded local $defs into components', () => {
		const edgeRuleAction = z.object({
			type: z.literal('rewrite'),
			value: z.string()
		})
		const app = new Elysia().post('/edge-rules', () => 'ok', {
			body: z.object({
				edgeRules: z.array(edgeRuleAction),
				fallback: edgeRuleAction
			})
		})

		const schema = JSON.parse(
			JSON.stringify(
				toOpenAPISchema(app, undefined, undefined, {
					zod: (schema, context) =>
						z.toJSONSchema(schema, {
							io: context.io,
							target: context.target,
							reused: 'ref'
						})
				})
			)
		)

		const bodySchema =
			schema.paths['/edge-rules'].post.requestBody.content[
				'application/json'
			].schema

		expect(JSON.stringify(schema)).not.toContain('#/$defs/')
		expect(bodySchema.$defs).toBeUndefined()
		expect(bodySchema.properties.edgeRules.items).toEqual({
			$ref: '#/components/schemas/__schema0'
		})
		expect(bodySchema.properties.fallback).toEqual({
			$ref: '#/components/schemas/__schema0'
		})
		expect(schema.components.schemas.__schema0).toEqual({
			type: 'object',
			properties: {
				type: {
					type: 'string',
					const: 'rewrite'
				},
				value: {
					type: 'string'
				}
			},
			required: ['type', 'value']
		})
	})

	it('excludes websocket routes from OpenAPI paths', () => {
		const app = new Elysia()
			.ws('/v1/events/ws', {
				message() {}
			})
			.get('/health', () => 'ok')

		const schema = JSON.parse(JSON.stringify(toOpenAPISchema(app)))

		expect(schema.paths['/v1/events/ws']).toBeUndefined()
		expect(schema.paths['/health'].get).toBeDefined()
	})

	it('emits QUERY routes only for OpenAPI 3.2', () => {
		const app = new Elysia().route('QUERY', '/search', () => 'ok', {
			body: t.Object({ filter: t.String() })
		})

		const openapi31 = JSON.parse(
			JSON.stringify(
				toOpenAPISchema(
					app,
					undefined,
					undefined,
					undefined,
					'3.1.2'
				)
			)
		)
		const openapi32 = JSON.parse(
			JSON.stringify(
				toOpenAPISchema(
					app,
					undefined,
					undefined,
					undefined,
					'3.2.0'
				)
			)
		)

		expect(openapi31.paths['/search']).toBeUndefined()
		expect(openapi32.paths['/search'].query.requestBody).toBeDefined()
		expect(openapi32.paths['/search'].query.operationId).toBe('querySearch')
	})

	it('uses additionalOperations for extended HTTP methods in OpenAPI 3.2', () => {
		const app = new Elysia()
			.route('PROPFIND', '/dav', () => 'ok')
			.route('CUSTOM', '/custom', () => 'ok')
		const schema = JSON.parse(
			JSON.stringify(
				toOpenAPISchema(
					app,
					undefined,
					undefined,
					undefined,
					'3.2.0'
				)
			)
		)

		expect(schema.paths['/dav'].propfind).toBeUndefined()
		expect(
			schema.paths['/dav'].additionalOperations.PROPFIND.operationId
		).toBe('propfindDav')
		expect(
			schema.paths['/custom'].additionalOperations.CUSTOM.operationId
		).toBe('customCustom')
	})

	it('throws on empty Standard Schema conversion when strict mode is enabled', () => {
		const emptyStandardSchema = {
			'~standard': {
				vendor: 'empty',
				jsonSchema: {
					input: () => ({}),
					output: () => ({})
				}
			}
		} as any
		const app = new Elysia().post('/empty', () => 'ok', {
			body: emptyStandardSchema
		})

		expect(() =>
			toOpenAPISchema(
				app,
				undefined,
				undefined,
				undefined,
				'3.1.2',
				{
					strictSchemaConversion: true
				}
			)
		).toThrow('Schema conversion returned an empty schema object')
	})

	it('merges detail requestBody metadata with generated body content', () => {
		const app = new Elysia().post('/custom-detail', () => 'ok', {
			body: z.object({
				name: z.string()
			}),
			parse: async ({ request }) => JSON.parse(await request.text()),
			detail: {
				requestBody: {
					description: 'Explicit request metadata',
					required: false,
					content: {
						'application/vnd.example+json': {
							schema: {
								type: 'object',
								properties: {
									name: { type: 'string' }
								},
								required: ['name']
							}
						}
					}
				}
			}
		})

		const requestBody = JSON.parse(
			JSON.stringify(
				toOpenAPISchema(app, undefined, undefined, {
					zod: z.toJSONSchema
				})
			)
		).paths['/custom-detail'].post.requestBody

		expect(requestBody.description).toBe('Explicit request metadata')
		expect(requestBody.required).toBe(false)
		expect(
			requestBody.content['application/vnd.example+json']
		).toBeDefined()
		expect(
			requestBody.content['application/json'].schema.properties.name
		).toEqual({ type: 'string' })
	})

	it('deep merges detail requestBody media type metadata', () => {
		const app = new Elysia().post('/custom-detail-json', () => 'ok', {
			body: z.object({
				name: z.string()
			}),
			detail: {
				requestBody: {
					content: {
						'application/json': {
							examples: {
								default: {
									value: {
										name: 'Lilith'
									}
								}
							}
						}
					}
				}
			}
		})

		const requestBody = JSON.parse(
			JSON.stringify(
				toOpenAPISchema(app, undefined, undefined, {
					zod: z.toJSONSchema
				})
			)
		).paths['/custom-detail-json'].post.requestBody

		expect(
			requestBody.content['application/json'].schema.properties.name
		).toEqual({ type: 'string' })
		expect(requestBody.content['application/json'].examples).toEqual({
			default: {
				value: {
					name: 'Lilith'
				}
			}
		})
	})

	it('merges OpenAPI schema metadata helpers into converted schemas', () => {
		const app = new Elysia().post(
			'/schema-metadata',
			() => ({ type: 'user', name: 'Lilith' }),
			{
				body: withOpenAPISchema(
					z.object({
						type: z.literal('user'),
						name: z.string()
					}),
					{
						examples: [
							{
								type: 'user',
								name: 'Lilith'
							}
						]
					}
				),
				response: withDiscriminator(
					t.Object({
						type: t.String(),
						name: t.String()
					}),
					{
						propertyName: 'type',
						mapping: {
							user: '#/components/schemas/User'
						}
					}
				)
			}
		)

		const schema = JSON.parse(
			JSON.stringify(
				toOpenAPISchema(app, undefined, undefined, {
					zod: z.toJSONSchema
				})
			)
		)
		const bodySchema =
			schema.paths['/schema-metadata'].post.requestBody.content[
				'application/json'
			].schema
		const responseSchema =
			schema.paths['/schema-metadata'].post.responses['200'].content[
				'application/json'
			].schema

		expect(bodySchema.properties.name).toEqual({ type: 'string' })
		expect(bodySchema.examples).toEqual([
			{
				type: 'user',
				name: 'Lilith'
			}
		])
		expect(bodySchema.openapiSchema).toBeUndefined()
		expect(responseSchema.properties.type).toEqual({ type: 'string' })
		expect(responseSchema.discriminator).toEqual({
			propertyName: 'type',
			mapping: {
				user: '#/components/schemas/User'
			}
		})
	})

	it('handle response', () => {
		const app = new Elysia().get(
			'/user',
			() => ({ name: 'Lilith' }) as const,
			{
				response: t.Object({
					name: t.Literal('Lilith')
				})
			}
		)

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/user': {
					get: {
						operationId: 'getUser',
						responses: {
							'200': {
								content: {
									'application/json': {
										schema: {
											properties: {
												name: {
													const: 'Lilith',
													type: 'string'
												}
											},
											required: ['name'],
											type: 'object'
										}
									}
								},
								description: 'Response for status 200'
							}
						}
					}
				}
			}
		})
	})

	it('handle response headers', () => {
		const app = new Elysia().get(
			'/user',
			() => ({ name: 'Lilith' }) as const,
			{
				response: withHeaders(
					t.Object({
						name: t.Literal('Lilith')
					}),
					{
						'x-request-id': t.String()
					}
				)
			}
		)

		const schema = JSON.parse(JSON.stringify(toOpenAPISchema(app)))
		const response = schema.paths['/user'].get.responses['200']

		expect(response.headers).toEqual({
			'x-request-id': {
				schema: {
					type: 'string'
				}
			}
		})
		expect(
			response.content['application/json'].schema.headers
		).toBeUndefined()
	})

	it('uses explicit response content type metadata', () => {
		const app = new Elysia().get('/reports/csv', () => 'name\nLilith', {
			response: withContentType(
				t.String({
					description: 'CSV report'
				}),
				'text/csv; charset=utf-8'
			)
		})

		const response = JSON.parse(JSON.stringify(toOpenAPISchema(app))).paths[
			'/reports/csv'
		].get.responses['200']

		expect(response.content).toEqual({
			'text/csv; charset=utf-8': {
				schema: {
					description: 'CSV report',
					type: 'string'
				}
			}
		})
	})

	it('merges explicit OpenAPI response metadata from withResponse', () => {
		const app = new Elysia().get('/reports/export', () => 'name\nLilith', {
			response: withResponse(
				t.String({
					description: 'CSV report'
				}),
				{
					description: 'Generated CSV export',
					contentType: 'text/csv; charset=utf-8',
					headers: {
						'x-total-rows': {
							schema: {
								type: 'integer'
							}
						}
					},
					links: {
						manifest: {
							operationId: 'getExportManifest'
						}
					}
				}
			)
		})

		const response = JSON.parse(JSON.stringify(toOpenAPISchema(app))).paths[
			'/reports/export'
		].get.responses['200']

		expect(response).toEqual({
			description: 'Generated CSV export',
			headers: {
				'x-total-rows': {
					schema: {
						type: 'integer'
					}
				}
			},
			links: {
				manifest: {
					operationId: 'getExportManifest'
				}
			},
			content: {
				'text/csv; charset=utf-8': {
					schema: {
						description: 'CSV report',
						type: 'string'
					}
				}
			}
		})
	})

	it('deep merges explicit response media type metadata', () => {
		const app = new Elysia().get('/health', () => ({ ok: true }), {
			response: withResponse(
				t.Object({
					ok: t.Boolean()
				}),
				{
					content: {
						'application/json': {
							examples: {
								success: {
									value: {
										ok: true
									}
								}
							}
						}
					}
				}
			)
		})

		const response = JSON.parse(JSON.stringify(toOpenAPISchema(app))).paths[
			'/health'
		].get.responses['200']

		expect(response.content['application/json'].schema).toEqual({
			type: 'object',
			properties: {
				ok: { type: 'boolean' }
			},
			required: ['ok']
		})
		expect(response.content['application/json'].examples).toEqual({
			success: {
				value: {
					ok: true
				}
			}
		})
	})

	it('preserves OpenAPI 3.2 streaming response metadata', () => {
		const app = new Elysia().get('/events', () => 'event', {
			response: withResponse(t.String(), {
				summary: 'Event stream',
				contentType: 'text/event-stream',
				content: {
					'text/event-stream': {
						itemSchema: {
							type: 'object',
							properties: {
								data: { type: 'string' }
							}
						}
					}
				}
			})
		})

		const response = JSON.parse(
			JSON.stringify(
				toOpenAPISchema(
					app,
					undefined,
					undefined,
					undefined,
					'3.2.0'
				)
			)
		).paths['/events'].get.responses['200']

		expect(response.summary).toBe('Event stream')
		expect(response.content['text/event-stream']).toMatchObject({
			schema: { type: 'string' },
			itemSchema: {
				type: 'object',
				properties: {
					data: { type: 'string' }
				}
			}
		})
	})

	it('uses binary response helper for download endpoints', () => {
		const app = new Elysia().get('/invoices/pdf', () => '', {
			response: {
				200: withBinaryResponse('application/pdf', {
					description: 'Invoice PDF'
				})
			}
		})

		const response = JSON.parse(JSON.stringify(toOpenAPISchema(app))).paths[
			'/invoices/pdf'
		].get.responses['200']

		expect(response.content).toEqual({
			'application/pdf': {
				schema: {
					description: 'Invoice PDF',
					format: 'binary',
					type: 'string'
				}
			}
		})
	})

	it('handle multiple response status', () => {
		const app = new Elysia().get(
			'/user',
			() => ({ name: 'Lilith' }) as const,
			{
				response: {
					200: t.Object({
						name: t.Literal('Fouco')
					}),
					404: t.Object({
						name: t.Literal('Lilith')
					})
				}
			}
		)

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/user': {
					get: {
						operationId: 'getUser',
						responses: {
							'200': {
								content: {
									'application/json': {
										schema: {
											properties: {
												name: {
													const: 'Fouco',
													type: 'string'
												}
											},
											required: ['name'],
											type: 'object'
										}
									}
								},
								description: 'Response for status 200'
							},
							'404': {
								content: {
									'application/json': {
										schema: {
											properties: {
												name: {
													const: 'Lilith',
													type: 'string'
												}
											},
											required: ['name'],
											type: 'object'
										}
									}
								},
								description: 'Response for status 404'
							}
						}
					}
				}
			}
		})
	})

	it('handle response headers on multiple status responses', () => {
		const app = new Elysia().get(
			'/user',
			() => ({ name: 'Lilith' }) as const,
			{
				response: {
					200: withHeaders(
						t.Object({
							name: t.Literal('Fouco')
						}),
						{
							'x-rate-limit': t.Number()
						}
					),
					404: t.Object({
						name: t.Literal('Lilith')
					})
				}
			}
		)

		const schema = JSON.parse(JSON.stringify(toOpenAPISchema(app)))
		const responses = schema.paths['/user'].get.responses

		expect(responses['200'].headers).toEqual({
			'x-rate-limit': {
				schema: {
					type: 'number'
				}
			}
		})
		expect(responses['404'].headers).toBeUndefined()
	})

	it('does not mutate reused response schema when adding headers', () => {
		const response = t.Object({
			name: t.String()
		})

		const app = new Elysia()
			.get('/with-headers', () => ({ name: 'Lilith' }), {
				response: withHeaders(response, {
					'x-request-id': t.String()
				})
			})
			.get('/without-headers', () => ({ name: 'Lilith' }), {
				response
			})

		const schema = JSON.parse(JSON.stringify(toOpenAPISchema(app)))

		expect('headers' in response).toBe(false)
		expect(
			schema.paths['/with-headers'].get.responses['200'].headers
		).toEqual({
			'x-request-id': {
				schema: {
					type: 'string'
				}
			}
		})
		expect(
			schema.paths['/without-headers'].get.responses['200'].headers
		).toBeUndefined()
	})

	it('does not mutate reused standard response schemas', () => {
		const response = z.object({ name: z.string() })
		const app = new Elysia()
			.get('/with-standard-headers', () => ({ name: 'Lilith' }), {
				response: withHeaders(response, {
					'x-request-id': t.String()
				})
			})
			.get('/without-standard-headers', () => ({ name: 'Lilith' }), {
				response
			})

		const schema = JSON.parse(
			JSON.stringify(
				toOpenAPISchema(app, undefined, undefined, {
					zod: z.toJSONSchema
				})
			)
		)

		expect('headers' in response).toBe(false)
		expect(
			schema.paths['/with-standard-headers'].get.responses['200'].headers
		).toEqual({
			'x-request-id': {
				schema: { type: 'string' }
			}
		})
		expect(
			schema.paths['/without-standard-headers'].get.responses['200'].headers
		).toBeUndefined()
	})

	it('handle every parameters together', () => {
		const app = new Elysia().post(
			'/id/:id',
			() => ({ name: 'Lilith' }) as const,
			{
				body: t.Object({
					age: t.Number()
				}),
				params: t.Object({
					id: t.Number()
				}),
				query: t.Object({
					name: t.Literal('Lilith')
				}),
				headers: t.Object({
					'x-user-name': t.Literal('Lilith')
				}),
				cookie: t.Object({
					session: t.String()
				}),
				response: {
					200: t.Object({
						name: t.Literal('Fouco')
					}),
					404: t.Object({
						name: t.Literal('Lilith')
					})
				}
			}
		)

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/id/{id}': {
					post: {
						operationId: 'postIdById',
						parameters: [
							{
								in: 'path',
								name: 'id',
								required: true,
								schema: {
									type: 'number'
								}
							},
							{
								in: 'query',
								name: 'name',
								required: true,
								schema: {
									const: 'Lilith',
									type: 'string'
								}
							},
							{
								in: 'header',
								name: 'x-user-name',
								required: true,
								schema: {
									const: 'Lilith',
									type: 'string'
								}
							},
							{
								in: 'cookie',
								name: 'session',
								required: true,
								schema: {
									type: 'string'
								}
							}
						],
						requestBody: {
							content: {
								'application/json': {
									schema: {
										properties: {
											age: {
												type: 'number'
											}
										},
										required: ['age'],
										type: 'object'
									}
								}
							},
							required: true
						},
						responses: {
							'200': {
								content: {
									'application/json': {
										schema: {
											properties: {
												name: {
													const: 'Fouco',
													type: 'string'
												}
											},
											required: ['name'],
											type: 'object'
										}
									}
								},
								description: 'Response for status 200'
							},
							'404': {
								content: {
									'application/json': {
										schema: {
											properties: {
												name: {
													const: 'Lilith',
													type: 'string'
												}
											},
											required: ['name'],
											type: 'object'
										}
									}
								},
								description: 'Response for status 404'
							}
						}
					}
				}
			}
		})
	})

	it('handle params', () => {
		const app = new Elysia().get('/user/:user', () => 'hello', {
			params: t.Object({
				user: t.Number()
			})
		})

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/user/{user}': {
					get: {
						operationId: 'getUserByUser',
						parameters: [
							{
								in: 'path',
								name: 'user',
								required: true,
								schema: {
									type: 'number'
								}
							}
						]
					}
				}
			}
		})
	})

	it('inline reference params', () => {
		const model = new Elysia().model(
			'headers',
			t.Object({
				'x-user-name': t.Literal('Lilith')
			})
		)

		const app = new Elysia().use(model).get('/user/:user', () => 'hello', {
			headers: 'headers'
		})

		is(app, {
			components: {
				schemas: {
					headers: {
						$id: '#/components/schemas/headers',
						properties: {
							'x-user-name': {
								const: 'Lilith',
								type: 'string'
							}
						},
						required: ['x-user-name'],
						type: 'object'
					}
				}
			},
			paths: {
				'/user/{user}': {
					get: {
						operationId: 'getUserByUser',
						parameters: [
							{
								in: 'path',
								name: 'user',
								required: true,
								schema: {
									type: 'string'
								}
							},
							{
								in: 'header',
								name: 'x-user-name',
								required: true,
								schema: {
									const: 'Lilith',
									type: 'string'
								}
							}
						]
					}
				}
			}
		})
	})

	it('inline reference query', () => {
		const model = new Elysia().model(
			'query',
			t.Object({
				name: t.Literal('Lilith')
			})
		)

		const app = new Elysia().use(model).get('/user', () => 'hello', {
			query: 'query'
		})

		is(app, {
			components: {
				schemas: {
					query: {
						$id: '#/components/schemas/query',
						properties: {
							name: {
								const: 'Lilith',
								type: 'string'
							}
						},
						required: ['name'],
						type: 'object'
					}
				}
			},
			paths: {
				'/user': {
					get: {
						operationId: 'getUser',
						parameters: [
							{
								in: 'query',
								name: 'name',
								required: true,
								schema: {
									const: 'Lilith',
									type: 'string'
								}
							}
						]
					}
				}
			}
		})
	})

	it('inline reference cookie', () => {
		const model = new Elysia().model(
			'cookie',
			t.Object({
				name: t.Literal('Lilith')
			})
		)

		const app = new Elysia().use(model).get('/user', () => 'hello', {
			cookie: 'cookie'
		})

		is(app, {
			components: {
				schemas: {
					cookie: {
						$id: '#/components/schemas/cookie',
						properties: {
							name: {
								const: 'Lilith',
								type: 'string'
							}
						},
						required: ['name'],
						type: 'object'
					}
				}
			},
			paths: {
				'/user': {
					get: {
						operationId: 'getUser',
						parameters: [
							{
								in: 'cookie',
								name: 'name',
								required: true,
								schema: {
									const: 'Lilith',
									type: 'string'
								}
							}
						]
					}
				}
			}
		})
	})

	it('reference body', () => {
		const model = new Elysia().model(
			'body',
			t.Object({
				name: t.Literal('Lilith')
			})
		)

		const app = new Elysia().use(model).post('/user', () => 'hello', {
			body: 'body'
		})

		is(app, {
			components: {
				schemas: {
					body: {
						$id: '#/components/schemas/body',
						properties: {
							name: {
								const: 'Lilith',
								type: 'string'
							}
						},
						required: ['name'],
						type: 'object'
					}
				}
			},
			paths: {
				'/user': {
					post: {
						operationId: 'postUser',
						requestBody: {
							content: {
								'application/json': {
									schema: {
										$ref: '#/components/schemas/body'
									}
								}
							},
							required: true
						}
					}
				}
			}
		})
	})

	it('reference response', () => {
		const model = new Elysia().model({
			lilith: t.Object({
				name: t.Literal('Lilith')
			})
		})

		const app = new Elysia().use(model).post(
			'/user',
			() =>
				({
					name: 'Lilith'
				}) as const,
			{
				response: 'lilith'
			}
		)

		is(app, {
			components: {
				schemas: {
					lilith: {
						$id: '#/components/schemas/lilith',
						properties: {
							name: {
								const: 'Lilith',
								type: 'string'
							}
						},
						required: ['name'],
						type: 'object'
					}
				}
			},
			paths: {
				'/user': {
					post: {
						operationId: 'postUser',
						responses: {
							'200': {
								content: {
									'application/json': {
										schema: {
											$ref: '#/components/schemas/lilith'
										}
									}
								},
								description: 'Response for status 200'
							}
						}
					}
				}
			}
		})
	})

	it('normalizes nested TypeBox refs', () => {
		const app = new Elysia()
			.model(
				'user',
				t.Object({
					name: t.String()
				})
			)
			.get('/profile', () => ({ user: { name: 'Lilith' } }), {
				response: t.Object({
					user: t.Ref('user')
				})
			})

		const schema = JSON.parse(JSON.stringify(toOpenAPISchema(app)))

		expect(
			schema.paths['/profile'].get.responses['200'].content[
				'application/json'
			].schema.properties.user
		).toEqual({
			$ref: '#/components/schemas/user'
		})
	})

	it('reference multiple response', () => {
		const model = new Elysia().model({
			lilith: t.Object({
				name: t.Literal('Lilith')
			}),
			fouco: t.Object({
				name: t.Literal('Fouco')
			})
		})

		const app = new Elysia().use(model).post(
			'/user',
			() =>
				({
					name: 'Lilith'
				}) as const,
			{
				response: {
					200: 'fouco',
					404: 'lilith'
				}
			}
		)

		is(app, {
			components: {
				schemas: {
					lilith: {
						$id: '#/components/schemas/lilith',
						properties: {
							name: {
								const: 'Lilith',
								type: 'string'
							}
						},
						required: ['name'],
						type: 'object'
					},
					fouco: {
						$id: '#/components/schemas/fouco',
						properties: {
							name: {
								const: 'Fouco',
								type: 'string'
							}
						},
						required: ['name'],
						type: 'object'
					}
				}
			},
			paths: {
				'/user': {
					post: {
						operationId: 'postUser',
						responses: {
							'200': {
								content: {
									'application/json': {
										schema: {
											$ref: '#/components/schemas/fouco'
										}
									}
								},
								description: 'Response for status 200'
							},
							'404': {
								content: {
									'application/json': {
										schema: {
											$ref: '#/components/schemas/lilith'
										}
									}
								},
								description: 'Response for status 404'
							}
						}
					}
				}
			}
		})
	})

	it('accept detail', () => {
		const app = new Elysia().get('/user', () => 'hello', {
			detail: {
				summary: 'Get User',
				description: 'Hello User',
				tags: ['User']
			}
		})

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/user': {
					get: {
						summary: 'Get User',
						operationId: 'getUser',
						description: 'Hello User',
						tags: ['User']
					}
				}
			}
		})
	})

	it('use custom operationId', () => {
		const app = new Elysia().get('/user', () => 'hello', {
			detail: {
				operationId: 'helloUser'
			}
		})

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/user': {
					get: {
						operationId: 'helloUser'
					}
				}
			}
		})
	})

	it('sanitizes generated operationId path segments', () => {
		const app = new Elysia().get(
			'/.well-known/acme-challenge/:token',
			() => 'ok'
		)

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/.well-known/acme-challenge/{token}': {
					get: {
						operationId: 'getWellKnownAcmeChallengeByToken',
						parameters: [
							{
								in: 'path',
								name: 'token',
								required: true,
								schema: {
									type: 'string'
								}
							}
						]
					}
				}
			}
		})
	})

	it('deduplicates generated operationIds after sanitizing path segments', () => {
		const app = new Elysia()
			.get('/foo-bar', () => 'first')
			.get('/foo_bar', () => 'second')

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/foo-bar': {
					get: {
						operationId: 'getFooBar'
					}
				},
				'/foo_bar': {
					get: {
						operationId: 'getFooBar2'
					}
				}
			}
		})
	})

	it('deduplicates custom operationIds', () => {
		const app = new Elysia()
			.get('/first', () => 'first', {
				detail: {
					operationId: 'downloadFile'
				}
			})
			.get('/second', () => 'second', {
				detail: {
					operationId: 'downloadFile'
				}
			})

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/first': {
					get: {
						operationId: 'downloadFile'
					}
				},
				'/second': {
					get: {
						operationId: 'downloadFile2'
					}
				}
			}
		})
	})

	it('has path parameter without schema argument', () => {
		const app = new Elysia().get('/user/:user/id/:id', () => 'hello')

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/user/{user}/id/{id}': {
					get: {
						operationId: 'getUserByUserIdById',
						parameters: [
							{
								in: 'path',
								name: 'user',
								required: true,
								schema: {
									type: 'string'
								}
							},
							{
								in: 'path',
								name: 'id',
								required: true,
								schema: {
									type: 'string'
								}
							}
						]
					}
				}
			}
		})
	})

	it('list all possible path', () => {
		const app = new Elysia().get('/user/:user?/id/:id?', () => 'hello')

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/user/id': {
					get: {
						operationId: 'getUserId2',
						parameters: [
							{
								in: 'path',
								name: 'user',
								required: true,
								schema: {
									type: 'string'
								}
							},
							{
								in: 'path',
								name: 'id',
								required: true,
								schema: {
									type: 'string'
								}
							}
						]
					}
				},
				'/user/id/{id}': {
					get: {
						operationId: 'getUserIdById',
						parameters: [
							{
								in: 'path',
								name: 'user',
								required: true,
								schema: {
									type: 'string'
								}
							},
							{
								in: 'path',
								name: 'id',
								required: true,
								schema: {
									type: 'string'
								}
							}
						]
					}
				},
				'/user/{user}/id': {
					get: {
						operationId: 'getUserByUserId',
						parameters: [
							{
								in: 'path',
								name: 'user',
								required: true,
								schema: {
									type: 'string'
								}
							},
							{
								in: 'path',
								name: 'id',
								required: true,
								schema: {
									type: 'string'
								}
							}
						]
					}
				},
				'/user/{user}/id/{id}': {
					get: {
						operationId: 'getUserByUserIdById',
						parameters: [
							{
								in: 'path',
								name: 'user',
								required: true,
								schema: {
									type: 'string'
								}
							},
							{
								in: 'path',
								name: 'id',
								required: true,
								schema: {
									type: 'string'
								}
							}
						]
					}
				}
			}
		})
	})

	it('exclude handle body get and head', () => {
		const app = new Elysia()
			.get('/user', () => 'hello', {
				body: t.Object({
					name: t.Literal('Lilith')
				})
			})
			.head('/user', () => 'hello', {
				body: t.Object({
					name: t.Literal('Lilith')
				})
			})

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/user': {
					get: {
						operationId: 'getUser'
					},
					head: {
						operationId: 'headUser'
					}
				}
			}
		})
	})

	it('keeps dotted API paths while excluding file-like static paths', () => {
		const app = new Elysia()
			.get('/test.2', () => 'hello')
			.group('/v1.2', (app) =>
				app.get('/test', () => ({
					status: 'ok'
				}))
			)
			.get('/favicon.ico', () => 'icon')

		const schema = JSON.parse(JSON.stringify(toOpenAPISchema(app)))

		expect(schema.paths['/test.2']).toBeDefined()
		expect(schema.paths['/v1.2/test']).toBeDefined()
		expect(schema.paths['/favicon.ico']).toBeUndefined()
	})

	it('keeps regex path exclusion stable for global patterns', () => {
		const app = new Elysia()
			.get('/internal/a', () => 'hidden')
			.get('/internal/b', () => 'hidden')
			.get('/public', () => 'visible')

		const schema = JSON.parse(
			JSON.stringify(
				toOpenAPISchema(app, {
					paths: [/^\/internal/g]
				})
			)
		)

		expect(schema.paths['/internal/a']).toBeUndefined()
		expect(schema.paths['/internal/b']).toBeUndefined()
		expect(schema.paths['/public']).toBeDefined()
	})

	it('response accept annotation', () => {
		const model = new Elysia().model({
			lilith: t.Object(
				{
					name: t.Literal('Lilith')
				},
				{
					description: 'Existed'
				}
			)
		})

		const app = new Elysia().use(model).post(
			'/user',
			() =>
				({
					name: 'Lilith'
				}) as const,
			{
				response: {
					200: t.Object(
						{
							name: t.Literal('Fouco')
						},
						{
							description: 'Demon Lord and Rhythm Gamer'
						}
					),
					404: 'lilith'
				}
			}
		)

		is(app, {
			components: {
				schemas: {
					lilith: {
						$id: '#/components/schemas/lilith',
						description: 'Existed',
						properties: {
							name: {
								const: 'Lilith',
								type: 'string'
							}
						},
						required: ['name'],
						type: 'object'
					}
				}
			},
			paths: {
				'/user': {
					post: {
						operationId: 'postUser',
						responses: {
							'200': {
								content: {
									'application/json': {
										schema: {
											description:
												'Demon Lord and Rhythm Gamer',
											properties: {
												name: {
													const: 'Fouco',
													type: 'string'
												}
											},
											required: ['name'],
											type: 'object'
										}
									}
								},
								description: 'Demon Lord and Rhythm Gamer'
							},
							'404': {
								content: {
									'application/json': {
										schema: {
											$ref: '#/components/schemas/lilith'
										}
									}
								},
								description: 'Existed'
							}
						}
					}
				}
			}
		})
	})

	it('body should be text/plain on primitive value', () => {
		const model = new Elysia().model('lilith', t.Literal('Lilith'))

		const app = new Elysia().use(model).post('/user', () => 'hello', {
			body: 'lilith'
		})

		is(app, {
			components: {
				schemas: {
					lilith: {
						$id: '#/components/schemas/lilith',
						const: 'Lilith',
						type: 'string'
					}
				}
			},
			paths: {
				'/user': {
					post: {
						operationId: 'postUser',
						requestBody: {
							content: {
								'text/plain': {
									schema: {
										$ref: '#/components/schemas/lilith'
									}
								}
							},
							required: true
						}
					}
				}
			}
		})
	})

	it('merge multiple standard standalone schema', () => {
		const app = new Elysia()
			.macro('fooBar', {
				query: z.object({
					foo: z.optional(z.string())
				}),
				resolve({ query }) {
					return { test: query.foo ? 'foo' : 'bar' }
				}
			})
			.get(
				'/',
				({ test, query }) => {
					const { foo, bar } = query
					return { ok: true, test, foo, bar }
				},
				{
					query: z.object({
						bar: z.optional(z.string())
					}),
					fooBar: true
				}
			)

		is(app, {
			components: {
				schemas: {}
			},
			paths: {
				'/': {
					get: {
						operationId: 'getIndex',
						parameters: [
							{
								in: 'query',
								name: 'bar',
								required: false,
								schema: {
									type: 'string'
								}
							},
							{
								in: 'query',
								name: 'foo',
								required: false,
								schema: {
									type: 'string'
								}
							}
						]
					}
				}
			}
		})
	})

	it('include body schema when parse is "none"', () => {
		const app = new Elysia().post(
			'/echo',
			({ request }) => request,
			{
				body: t.Object({ input: t.String() }),
				parse: 'none'
			}
		)

		const schema = JSON.parse(JSON.stringify(toOpenAPISchema(app)))

		expect(schema.paths['/echo'].post.requestBody).toBeDefined()
		expect(schema.paths['/echo'].post.requestBody.content).toBeDefined()
		expect(
			schema.paths['/echo'].post.requestBody.content['application/json']
		).toBeDefined()
		expect(
			schema.paths['/echo'].post.requestBody.content['application/json'].schema
		).toEqual({
			type: 'object',
			properties: {
				input: { type: 'string' }
			},
			required: ['input']
		})
	})
})

describe('OpenAPI > ArkType', () => {
	// ArkType emits the JSON Schema `$schema` dialect on each converted schema.
	const $schema = 'https://json-schema.org/draft/2020-12/schema'

	// Body schemas default to JSON unless the route declares a parser/content type.
	const body = (s: Record<string, unknown>) => ({
		content: {
			'application/json': { schema: s }
		},
		required: true
	})

	const doc = (app: AnyElysia) =>
		JSON.parse(JSON.stringify(toOpenAPISchema(app)))

	// https://github.com/elysiajs/elysia/issues/1844
	it('degrades a predicate (string.date) instead of dropping the schema', () => {
		const app = new Elysia().post('/bug', () => 'ok', {
			body: type({ date: 'string.date' })
		})

		is(app, {
			components: { schemas: {} },
			paths: {
				'/bug': {
					post: {
						operationId: 'postBug',
						requestBody: body({
							$schema,
							type: 'object',
							properties: { date: { type: 'string' } },
							required: ['date']
						})
					}
				}
			}
		})
	})

	it('maps a Date to string/date-time', () => {
		const app = new Elysia().post('/at', () => 'ok', {
			body: type({ at: 'Date' })
		})

		is(app, {
			components: { schemas: {} },
			paths: {
				'/at': {
					post: {
						operationId: 'postAt',
						requestBody: body({
							$schema,
							type: 'object',
							properties: {
								at: { type: 'string', format: 'date-time' }
							},
							required: ['at']
						})
					}
				}
			}
		})
	})

	it('leaves a predicate-free schema unchanged', () => {
		const app = new Elysia().post('/plain', () => 'ok', {
			body: type({ name: 'string', age: 'number' })
		})

		expect(
			doc(app).paths['/plain'].post.requestBody.content[
				'application/json'
			].schema
		).toEqual({
			$schema,
			type: 'object',
			properties: { name: { type: 'string' }, age: { type: 'number' } },
			required: ['age', 'name']
		})
	})

	// Morphs (e.g. `string.date.parse`) previously threw `code: "morph"` and
	// dropped the schema; the `default` fallback degrades them to the base type.
	it('degrades a morph (string.date.parse) instead of dropping the schema', () => {
		const app = new Elysia().post('/morph', () => 'ok', {
			body: type({ when: 'string.date.parse' })
		})

		const op = doc(app).paths['/morph'].post

		expect(op.requestBody).toBeDefined()
		expect(
			op.requestBody.content['application/json'].schema.properties.when
		).toEqual({ type: 'string' })
	})

	it('lets a user-supplied mapJsonSchema.arktype override win', () => {
		const app = new Elysia().post('/override', () => 'ok', {
			body: type({ date: 'string.date' })
		})

		const override = {
			type: 'object',
			properties: { date: { type: 'string', format: 'overridden' } },
			required: ['date']
		}

		const result = JSON.parse(
			JSON.stringify(
				toOpenAPISchema(app, undefined, undefined, {
					arktype: () => override
				})
			)
		)

		expect(
			result.paths['/override'].post.requestBody.content[
				'application/json'
			].schema
		).toEqual(override)
	})
})
