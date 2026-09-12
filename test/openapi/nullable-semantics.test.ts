import { describe, expect, it } from 'bun:test'
import Ajv2020 from 'ajv/dist/2020'
import { Elysia } from 'elysia'
import { z } from 'zod'
import { openapi } from '../../src'
import { nullToOpenApi } from '../../src/openapi'

const validator = new Ajv2020({ strict: false, validateFormats: false })

describe('OpenAPI 3.1 nullable validation', () => {
	const fixtures = [
		{
			schema: {
				anyOf: [
					{ type: 'string', enum: ['INIT', 'BUILD'] },
					{ type: 'null' }
				]
			},
			values: [null, 'INIT', 'BUILD', 'OTHER', 0]
		},
		{
			schema: {
				anyOf: [{ type: 'string', const: 'READY' }, { type: 'null' }]
			},
			values: [null, 'READY', 'OTHER', 0]
		},
		{
			schema: {
				anyOf: [
					{ type: 'string', not: { const: null } },
					{ type: 'null' }
				]
			},
			values: [null, 'READY', 0]
		},
		{
			schema: {
				type: 'string',
				anyOf: [{ type: 'string' }, { type: 'null' }]
			},
			values: [null, 'READY', 0]
		},
		{
			schema: {
				oneOf: [{ type: 'string' }, { type: 'null' }, { type: 'null' }]
			},
			values: [null, 'READY', 0]
		}
	]
	for (const [index, { schema, values }] of fixtures.entries()) {
		it(`preserves allowed values for union ${index}`, () => {
			const before = validator.compile(schema)
			const after = validator.compile(nullToOpenApi(schema, '3.1.2'))
			for (const value of values) expect(after(value)).toBe(before(value))
		})
	}

	it('describes the actual nullable enum HTTP response', async () => {
		const response = z.object({
			failurePhase: z.enum(['INIT', 'BUILD']).nullable()
		})
		const app = new Elysia()
			.use(
				openapi({
					mapJsonSchema: {
						zod: (schema) => z.toJSONSchema(schema as z.ZodType)
					}
				})
			)
			.get('/session', () => ({ failurePhase: null }), { response })
		const actual = await app.handle(new Request('http://localhost/session'))
		expect(actual.status).toBe(200)
		const body = await actual.json()
		const document = await (
			await app.handle(new Request('http://localhost/openapi/json'))
		).json()
		const schema =
			document.paths['/session'].get.responses['200'].content[
				'application/json'
			].schema
		const validate = validator.compile(schema)
		expect(validate(body)).toBe(true)
		expect(validate({ failurePhase: 'BUILD' })).toBe(true)
		expect(validate({ failurePhase: 'UNKNOWN' })).toBe(false)
		expect(validate({})).toBe(false)
	})
})
