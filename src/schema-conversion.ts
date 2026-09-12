import { t, type InputSchema } from 'elysia'
import { Kind, type TAnySchema } from '@sinclair/typebox'
import type { OpenAPIV3 } from 'openapi-types'
import type {
	JsonSchemaConversionContext,
	MapJsonSchema,
	OpenAPIVersion,
	StrictSchemaConversion
} from './types'

export const componentRef = (name: string) =>
	t.Ref(name.startsWith('#/') ? name : `#/components/schemas/${name}`)

const toRef = componentRef

const warnings = {
	zod4: `import openapi from '@onreza/elysia-openapi'
import * as z from 'zod'

openapi({
  mapJsonSchema: {
    zod: z.toJSONSchema
  }
})`,
	zod3: `import openapi from '@onreza/elysia-openapi'
import { zodToJsonSchema } from 'zod-to-json-schema'

openapi({
  mapJsonSchema: {
    zod: zodToJsonSchema
  }
})`,
	valibot: `import openapi from '@onreza/elysia-openapi'
import { toJsonSchema } from '@valibot/to-json-schema'

openapi({
  mapJsonSchema: {
    valibot: toJsonSchema
  }
})`,
	effect: `import { JSONSchema } from 'effect'

openapi({
  mapJsonSchema: {
    effect: JSONSchema.make
  }
})`
} as const

const warned = {} as Record<keyof typeof warnings, boolean | undefined>

export const unwrapReference = <T extends OpenAPIV3.SchemaObject | undefined>(
	schema: T,
	definitions: Record<string, unknown>
):
	| Exclude<T, OpenAPIV3.SchemaObject>
	| (Omit<NonNullable<T>, 'type'> & {
			$ref: string
			type: string | undefined
	  }) => {
	// @ts-ignore
	const ref = schema?.$ref
	if (!ref) return schema as any

	const name = ref.slice(ref.lastIndexOf('/') + 1)
	if (ref && definitions[name]) schema = definitions[name] as T

	return enumToOpenApi(schema) as any
}

export type OpenAPISchemaMetadata = Partial<OpenAPIV3.SchemaObject> &
	Record<string, unknown>

const toJsonSchemaTarget = (openapiVersion: OpenAPIVersion) =>
	openapiVersion.startsWith('3.0.') ? 'openapi-3.0' : 'draft-2020-12'

const toSchemaConversionContext = (
	schema: unknown,
	io: JsonSchemaConversionContext['io'],
	openapiVersion: OpenAPIVersion,
	strictSchemaConversion?: StrictSchemaConversion
): JsonSchemaConversionContext => {
	const vendor =
		schema && typeof schema === 'object'
			? String((schema as any)['~standard']?.vendor ?? 'unknown')
			: 'unknown'

	return {
		vendor,
		io,
		typeMode: io,
		openapiVersion,
		target: toJsonSchemaTarget(openapiVersion),
		strictSchemaConversion
	}
}

const toOpenAPISchemaMetadata = (schema: unknown) =>
	schema && typeof schema === 'object' && !Array.isArray(schema)
		? (schema as { openapiSchema?: OpenAPISchemaMetadata }).openapiSchema
		: undefined

const applyOpenAPISchemaMetadata = <
	T extends OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined
>(
	schema: T,
	metadata: OpenAPISchemaMetadata | undefined
): T => {
	if (!schema || typeof schema !== 'object') return schema

	const { openapiSchema, ...base } = schema as T & {
		openapiSchema?: unknown
	}

	if (!metadata) return base as T

	return {
		...base,
		...metadata
	} as T
}

const isEmptySchemaObject = (schema: unknown) =>
	schema &&
	typeof schema === 'object' &&
	!Array.isArray(schema) &&
	Object.keys(schema).length === 0

const reportSchemaConversionIssue = (
	context: JsonSchemaConversionContext,
	message: string,
	error?: unknown
) => {
	const fullMessage = `[@onreza/elysia-openapi] ${message} (vendor: ${context.vendor}, io: ${context.io}, target: ${context.target})`

	if (context.strictSchemaConversion === true) {
		const next = new Error(fullMessage)
		if (error && typeof error === 'object') {
			try {
				;(next as Error & { cause?: unknown }).cause = error
			} catch {}
		}
		throw next
	}

	if (context.strictSchemaConversion === 'warn' || error) {
		console.warn(fullMessage)
		if (error) console.warn(error)
	}
}

const finalizeConvertedSchema = (
	schema: unknown,
	context: JsonSchemaConversionContext,
	metadata?: OpenAPISchemaMetadata
): OpenAPIV3.SchemaObject | undefined => {
	const converted = applyOpenAPISchemaMetadata(
		normalizeSchemaForOpenAPIVersion(
			enumToOpenApi(schema as OpenAPIV3.SchemaObject),
			context.openapiVersion
		),
		metadata
	)

	if (!converted) {
		reportSchemaConversionIssue(context, 'Failed to convert schema')
		return
	}

	if (isEmptySchemaObject(converted))
		reportSchemaConversionIssue(
			context,
			'Schema conversion returned an empty schema object'
		)

	return converted
}

export const unwrapSchema = (
	schema: InputSchema['body'],
	mapJsonSchema?: MapJsonSchema,
	io: 'input' | 'output' = 'input',
	openapiVersion: OpenAPIVersion = '3.1.2',
	strictSchemaConversion?: StrictSchemaConversion
): OpenAPIV3.SchemaObject | undefined => {
	if (!schema) return

	const metadata = toOpenAPISchemaMetadata(schema)

	if (typeof schema === 'string') schema = toRef(schema)
	if (Kind in schema)
		return finalizeConvertedSchema(
			schema,
			toSchemaConversionContext(
				schema,
				io,
				openapiVersion,
				strictSchemaConversion
			),
			metadata
		)

	// Already unwrapped by merging standalone validators
	if (
		!schema?.['~standard'] &&
		// @ts-ignore
		(schema.$schema || schema.type || schema.properties || schema.items)
	)
		return finalizeConvertedSchema(
			schema,
			toSchemaConversionContext(
				schema,
				io,
				openapiVersion,
				strictSchemaConversion
			),
			metadata
		)

	if (!schema?.['~standard']) return

	// @ts-ignore
	const vendor = schema['~standard'].vendor
	const context = toSchemaConversionContext(
		schema,
		io,
		openapiVersion,
		strictSchemaConversion
	)

	try {
		if (
			mapJsonSchema?.[vendor] &&
			typeof mapJsonSchema[vendor] === 'function'
		)
			return finalizeConvertedSchema(
				mapJsonSchema[vendor](schema, context),
				context,
				metadata
			)

		// ============================================================================
		// ArkType toJsonSchema fallback (predicates, morphs, Date, etc.)
		// ============================================================================
		if (vendor === 'arktype')
			return finalizeConvertedSchema(
				// @ts-ignore
				schema?.toJsonSchema?.({
					fallback: {
						// real Date types -> string with date-time format
						date: (ctx: { base: Record<string, unknown> }) => ({
							...ctx.base,
							type: 'string',
							format: 'date-time'
						}),
						// anything else unrepresentable -> keep the base type
						default: (ctx: { base: Record<string, unknown> }) =>
							ctx.base
					}
				}),
				context,
				metadata
			)

		// @ts-ignore
		if (schema['~standard']?.jsonSchema?.[io])
			// @ts-ignore
			return finalizeConvertedSchema(
				// @ts-ignore
				schema['~standard'].jsonSchema[io]({
					target: context.target
				}),
				context,
				metadata
			)

		switch (vendor) {
			case 'zod':
				if (warned.zod4 || warned.zod3) break

				console.warn(
					"[@onreza/elysia-openapi] Zod doesn't provide JSON Schema method on the schema"
				)

				if ('_zod' in schema) {
					warned.zod4 = true

					console.warn(
						'For Zod v4, please provide z.toJSONSchema as follows:\n'
					)
					console.warn(warnings.zod4)
				} else {
					warned.zod3 = true

					console.warn(
						'For Zod v3, please install zod-to-json-schema package and use it like this:\n'
					)
					console.warn(warnings.zod3)
				}
				break

			case 'valibot':
				if (warned.valibot) break
				warned.valibot = true

				console.warn(
					'[@onreza/elysia-openapi] Valibot require a separate package for JSON Schema conversion'
				)
				console.warn(
					'Please install @valibot/to-json-schema package and use it like this:\n'
				)
				console.warn(warnings.valibot)
				break

			case 'effect':
				// Effect does not support toJsonSchema method
				// Users have to use third party library like effect-zod
				if (warned.effect) break
				warned.effect = true

				console.warn(
					"[@onreza/elysia-openapi] Effect Schema doesn't provide JSON Schema method on the schema"
				)
				console.warn(
					"please provide JSONSchema from 'effect' package as follows:\n"
				)
				console.warn(warnings.effect)
				break
		}

		return finalizeConvertedSchema(
			// @ts-ignore
			schema.toJSONSchema?.(context) ?? schema?.toJsonSchema?.(context),
			context,
			metadata
		)
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.startsWith('[@onreza/elysia-openapi]')
		)
			throw error

		reportSchemaConversionIssue(context, 'Schema conversion failed', error)
	}
}

const SCHEMA_OBJECT_MAP_KEYS = new Set([
	'properties',
	'patternProperties',
	'$defs',
	'definitions',
	'dependentSchemas'
])

const SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems'])

const SCHEMA_OR_BOOL_KEYS = new Set([
	'items',
	'additionalProperties',
	'unevaluatedProperties',
	'contains',
	'not',
	'if',
	'then',
	'else',
	'propertyNames'
])

const normalizeNullableSchemaForOAS30 = (schema: unknown): unknown => {
	if (!schema || typeof schema !== 'object') return schema

	if (Array.isArray(schema))
		return schema.map((item) => normalizeNullableSchemaForOAS30(item))

	const normalized = { ...(schema as Record<string, unknown>) }

	if (normalized.type === 'null') {
		delete normalized.type
		normalized.nullable = true
		return normalized
	}

	if (Array.isArray(normalized.type) && normalized.type.includes('null')) {
		const nonNullTypes = normalized.type.filter(
			(type) => type !== 'null'
		) as string[]

		normalized.nullable = true

		if (nonNullTypes.length === 1) normalized.type = nonNullTypes[0]
		else if (nonNullTypes.length > 1) normalized.type = nonNullTypes
		else delete normalized.type

		return normalized
	}

	if (Array.isArray(normalized.anyOf)) {
		const entries = normalized.anyOf as Array<Record<string, unknown>>
		const nonNullEntries = entries.filter((entry) => {
			const isNormalizedNullEntry =
				entry?.nullable === true &&
				!('type' in entry) &&
				Object.keys(entry).length === 1

			return entry?.type !== 'null' && !isNormalizedNullEntry
		})

		if (nonNullEntries.length !== entries.length) {
			normalized.nullable = true

			if (nonNullEntries.length === 1) {
				delete normalized.anyOf
				Object.assign(normalized, nonNullEntries[0])
			} else normalized.anyOf = nonNullEntries
		}
	}

	if (Array.isArray(normalized.oneOf)) {
		const entries = normalized.oneOf as Array<Record<string, unknown>>
		const nonNullEntries = entries.filter((entry) => {
			const isNormalizedNullEntry =
				entry?.nullable === true &&
				!('type' in entry) &&
				Object.keys(entry).length === 1

			return entry?.type !== 'null' && !isNormalizedNullEntry
		})

		if (nonNullEntries.length !== entries.length) {
			normalized.nullable = true

			if (nonNullEntries.length === 1) {
				delete normalized.oneOf
				Object.assign(normalized, nonNullEntries[0])
			} else normalized.oneOf = nonNullEntries
		}
	}

	for (const [key, value] of Object.entries(normalized)) {
		if (SCHEMA_OBJECT_MAP_KEYS.has(key)) {
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				const next: Record<string, unknown> = {}
				for (const [nestedKey, nestedValue] of Object.entries(value))
					next[nestedKey] =
						normalizeNullableSchemaForOAS30(nestedValue)
				normalized[key] = next
			}
			continue
		}

		if (SCHEMA_ARRAY_KEYS.has(key)) {
			if (Array.isArray(value))
				normalized[key] = value.map((item) =>
					normalizeNullableSchemaForOAS30(item)
				)
			continue
		}

		if (SCHEMA_OR_BOOL_KEYS.has(key)) {
			if (value && typeof value === 'object') {
				if (Array.isArray(value))
					normalized[key] = value.map((item) =>
						normalizeNullableSchemaForOAS30(item)
					)
				else normalized[key] = normalizeNullableSchemaForOAS30(value)
			}
			continue
		}

		if (key === 'dependencies') {
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				const next: Record<string, unknown> = {}
				for (const [nestedKey, nestedValue] of Object.entries(value))
					next[nestedKey] =
						nestedValue &&
						typeof nestedValue === 'object' &&
						!Array.isArray(nestedValue)
							? normalizeNullableSchemaForOAS30(nestedValue)
							: nestedValue
				normalized[key] = next
			}
		}
	}

	return normalized
}

export const nullToOpenApi = <T>(
	schema: T,
	openapiVersion: OpenAPIVersion
): T => {
	if (!schema) return schema

	if (openapiVersion.startsWith('3.0.'))
		return normalizeNullableSchemaForOAS30(schema) as T

	// OpenAPI 3.1 uses JSON Schema directly. Flattening unions changes enum,
	// const, conditional and parent constraints, so preserve their semantics.
	return schema
}

const normalizeSchemaForOpenAPIVersion = <T>(
	schema: T,
	openapiVersion: OpenAPIVersion
): T => {
	return nullToOpenApi(schema, openapiVersion)
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value)

const decodeJsonPointerSegment = (segment: string) =>
	segment.replace(/~1/g, '/').replace(/~0/g, '~')

const encodeJsonPointerSegment = (segment: string) =>
	segment.replace(/~/g, '~0').replace(/\//g, '~1')

const toComponentSchemaName = (name: string) =>
	decodeJsonPointerSegment(name).replace(/[^A-Za-z0-9._-]/g, '_') || 'Schema'

const reserveComponentSchemaName = (
	rawName: string,
	components: Record<string, unknown>
) => {
	const base = toComponentSchemaName(rawName)
	if (!(base in components)) return base

	let index = 2
	let name = `${base}${index}`
	while (name in components) {
		index++
		name = `${base}${index}`
	}

	return name
}

const rewriteLocalDefinitionRef = (
	ref: string,
	definitionRefs: Map<string, string>
) => {
	for (const definitionKey of ['$defs', 'definitions'] as const) {
		const prefix = `#/${definitionKey}/`
		if (!ref.startsWith(prefix)) continue

		const pointer = ref.slice(prefix.length)
		const [rawName, ...rest] = pointer.split('/')
		const componentName = definitionRefs.get(
			`${definitionKey}:${decodeJsonPointerSegment(rawName)}`
		)

		if (!componentName) return ref

		return [
			'#/components/schemas',
			encodeJsonPointerSegment(componentName),
			...rest
		].join('/')
	}

	return ref
}

const normalizeSchemaLocalDefinitions = <T>(
	value: T,
	components: Record<string, unknown>,
	definitionRefs = new Map<string, string>()
): T => {
	if (!value || typeof value !== 'object') return value

	if (Array.isArray(value))
		return value.map((item) =>
			normalizeSchemaLocalDefinitions(item, components, definitionRefs)
		) as T

	const schema = value as Record<string, unknown>
	const scopedDefinitionRefs = new Map(definitionRefs)

	for (const definitionKey of ['$defs', 'definitions'] as const) {
		const definitions = schema[definitionKey]
		if (!isPlainRecord(definitions)) continue

		for (const rawName of Object.keys(definitions)) {
			const componentName = reserveComponentSchemaName(
				rawName,
				components
			)
			components[componentName] = true
			scopedDefinitionRefs.set(
				`${definitionKey}:${rawName}`,
				componentName
			)
		}
	}

	for (const definitionKey of ['$defs', 'definitions'] as const) {
		const definitions = schema[definitionKey]
		if (!isPlainRecord(definitions)) continue

		for (const [rawName, definition] of Object.entries(definitions)) {
			const componentName = scopedDefinitionRefs.get(
				`${definitionKey}:${rawName}`
			)!
			components[componentName] = normalizeSchemaLocalDefinitions(
				definition,
				components,
				scopedDefinitionRefs
			)
		}
	}

	const normalized: Record<string, unknown> = {}

	for (const [key, nestedValue] of Object.entries(schema)) {
		if (key === '$defs' || key === 'definitions') continue

		normalized[key] =
			key === '$ref' && typeof nestedValue === 'string'
				? rewriteLocalDefinitionRef(nestedValue, scopedDefinitionRefs)
				: normalizeSchemaLocalDefinitions(
						nestedValue,
						components,
						scopedDefinitionRefs
					)
	}

	return normalized as T
}

export const normalizeOpenAPILocalDefinitions = (
	paths: OpenAPIV3.PathsObject,
	schemas: Record<string, unknown>
) => {
	const components = { ...schemas }

	for (const [name, schema] of Object.entries(components))
		components[name] = normalizeSchemaLocalDefinitions(schema, components)

	return {
		paths: normalizeSchemaLocalDefinitions(paths, components),
		schemas: components
	}
}

/**
 * Convert TypeBox enum-like Union schemas to OpenAPI enum schemas
 *
 * Otherwise, return the schema as is
 */
export const enumToOpenApi = <
	T extends
		| TAnySchema
		| OpenAPIV3.SchemaObject
		| OpenAPIV3.ReferenceObject
		| undefined
>(
	_schema: T
): T => {
	if (!_schema || typeof _schema !== 'object') return _schema

	if (Kind in _schema) {
		const schema = _schema as TAnySchema

		if (
			schema[Kind] === 'Union' &&
			schema.anyOf &&
			Array.isArray(schema.anyOf) &&
			schema.anyOf.length > 0 &&
			schema.anyOf.every(
				(item) =>
					item && typeof item === 'object' && item.const !== undefined
			)
		)
			return {
				type: 'string',
				enum: schema.anyOf.map((item) => item.const)
			} as any

		if (schema[Kind] === 'Ref' && schema.$ref)
			return toRef(schema.$ref) as any
	}

	if (Array.isArray(_schema))
		return _schema.map((item) => enumToOpenApi(item)) as unknown as T

	const schema = _schema as OpenAPIV3.SchemaObject & Record<string, unknown>

	// TypeBox's t.Date() serialises to anyOf: [{"type":"Date"}, ...].
	// "Date" is not a valid OpenAPI 3.0 type; replace it with
	// {"type":"string","format":"date-time"} which is what Elysia actually
	// serialises Date instances to on the wire.  Use replace (not filter) so
	// that nullable dates -- t.Nullable(t.Date()) -- keep their {"type":"null"}
	// sibling instead of collapsing to null-only.
	if (schema.anyOf && Array.isArray(schema.anyOf)) {
		const mapped = schema.anyOf.map((item) =>
			item &&
			typeof item === 'object' &&
			(item as Record<string, unknown>).type === 'Date'
				? { type: 'string', format: 'date-time' }
				: enumToOpenApi(item)
		)
		// Deduplicate: after the replacement above the anyOf may contain two
		// identical date-time entries because t.Date() already included one.
		// Compare by canonical (sorted-key) JSON to catch different key orderings.
		const seen = new Set<string>()
		const deduped = mapped.filter((item) => {
			if (!item || typeof item !== 'object') return true
			const key = JSON.stringify(
				Object.fromEntries(
					Object.entries(item as object).sort(([a], [b]) =>
						a < b ? -1 : a > b ? 1 : 0
					)
				)
			)
			if (seen.has(key)) return false
			seen.add(key)
			return true
		})
		if (deduped.length === 1) {
			const { anyOf, ...rest } = schema
			return { ...rest, ...(deduped[0] as object) } as T
		}
		return { ...schema, anyOf: deduped } as T
	}

	const normalized: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(schema))
		normalized[key] =
			value && typeof value === 'object'
				? enumToOpenApi(value as any)
				: value

	return normalized as T
}
