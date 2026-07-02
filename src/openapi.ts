import { t, type AnyElysia, type TSchema, type InputSchema } from 'elysia'
import type {
	HookContainer,
	LocalHook,
	RouteSchema,
	SingletonBase,
	StandardSchemaV1Like
} from 'elysia/types'

import type { OpenAPIV3 } from 'openapi-types'
import {
	Kind,
	TAnySchema,
	type TProperties,
	type TObject
} from '@sinclair/typebox'

import type {
	AdditionalReference,
	AdditionalReferences,
	ElysiaOpenAPIConfig,
	JsonSchemaConversionContext,
	MapJsonSchema,
	OpenAPIVersion,
	StrictSchemaConversion
} from './types'

export const capitalize = (word: string) =>
	word.charAt(0).toUpperCase() + word.slice(1)

export const componentRef = (name: string) =>
	t.Ref(name.startsWith('#/') ? name : `#/components/schemas/${name}`)

const toRef = componentRef

const toOperationIdSegment = (segment: string) => {
	if (!segment) return ''

	const isParam = segment.startsWith(':')
	const raw = segment.replace(/^:/, '').replace(/\?$/, '')
	const optional = segment.endsWith('?')
	const name = (raw.match(/[A-Za-z0-9]+/g) ?? [])
		.map(capitalize)
		.join('')

	if (!name) return ''

	return `${isParam ? 'By' : ''}${name}${optional ? 'Optional' : ''}`
}

const toOperationId = (method: string, paths: string) => {
	const prefix = method.toLowerCase()

	if (!paths || paths === '/') return prefix + 'Index'

	const segments = paths
		.split('/')
		.map(toOperationIdSegment)
		.filter(Boolean)

	return prefix + (segments.length ? segments.join('') : 'Index')
}

const uniqueOperationId = (
	operationId: string,
	operationIds: Map<string, number>
) => {
	const count = operationIds.get(operationId) ?? 0
	operationIds.set(operationId, count + 1)

	return count === 0 ? operationId : `${operationId}${count + 1}`
}

const OPENAPI_HTTP_METHODS = new Set([
	'get',
	'post',
	'put',
	'delete',
	'patch',
	'head',
	'options',
	'trace'
])

const optionalParamsRegex = /(\/:\w+\?)/g

/**
 * Get all possible paths of a path with optional parameters
 * @param {string} path
 * @returns {string[]} paths
 */
export const getPossiblePath = (path: string): string[] => {
	const optionalParams = path.match(optionalParamsRegex)
	if (!optionalParams) return [path]

	const originalPath = path.replace(/\?/g, '')
	const paths = [originalPath]

	for (let i = 0; i < optionalParams.length; i++) {
		const newPath = path.replace(optionalParams[i], '')

		paths.push(...getPossiblePath(newPath))
	}

	return paths
}

const isValidSchema = (schema: any): schema is TSchema =>
	schema &&
	typeof schema === 'object' &&
	((Kind in schema && schema[Kind] !== 'Unknown') ||
		schema.type ||
		schema.properties ||
		schema.items)

const isReferenceSchema = (schema: any): schema is TSchema | string =>
	typeof schema === 'string' || isValidSchema(schema)

export const getLoosePath = (path: string) => {
	if (path.charCodeAt(path.length - 1) === 47)
		return path.slice(0, path.length - 1)

	return path + '/'
}

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

// ============================================================================
// Schema Flattening Helpers
// ============================================================================

/**
 * Merge object schemas together
 * Returns merged object schema and any non-object schemas that couldn't be merged
 */
const mergeObjectSchemas = (
	schemas: TSchema[]
): {
	schema: TObject | undefined
	notObjects: TSchema[]
} => {
	if (schemas.length === 0)
		return {
			schema: undefined,
			notObjects: []
		}

	if (schemas.length === 1)
		return schemas[0].type === 'object'
			? {
					schema: schemas[0] as TObject,
					notObjects: []
				}
			: {
					schema: undefined,
					notObjects: schemas
				}

	let newSchema: TObject
	const notObjects = <TSchema[]>[]

	let additionalPropertiesIsTrue = false
	let additionalPropertiesIsFalse = false

	for (const schema of schemas) {
		if (!schema) continue

		if (schema.type !== 'object') {
			notObjects.push(schema)
			continue
		}

		if ('additionalProperties' in schema) {
			if (schema.additionalProperties === true)
				additionalPropertiesIsTrue = true
			else if (schema.additionalProperties === false)
				additionalPropertiesIsFalse = true
		}

		if (!newSchema!) {
			newSchema = schema as TObject
			continue
		}

		newSchema = {
			...newSchema,
			...schema,
			properties: {
				...newSchema.properties,
				...schema.properties
			},
			required: [
				...(newSchema?.required ?? []),
				...(schema.required ?? [])
			]
		} as TObject
	}

	if (newSchema!) {
		if (newSchema.required)
			newSchema.required = [...new Set(newSchema.required)]

		if (additionalPropertiesIsFalse) newSchema.additionalProperties = false
		else if (additionalPropertiesIsTrue)
			newSchema.additionalProperties = true
	}

	return {
		schema: newSchema!,
		notObjects
	}
}

/**
 * Check if a value is a TypeBox schema (vs a status code object)
 * Uses the TypeBox Kind symbol which all schemas have.
 *
 * This method distinguishes between:
 * - TypeBox schemas: Have the Kind symbol (unions, intersects, objects, etc.)
 * - Status code objects: Plain objects with numeric keys like { 200: schema, 404: schema }
 */
const isTSchema = (value: any): value is TSchema => {
	if (!value || typeof value !== 'object') return false

	// All TypeBox schemas have the Kind symbol
	if (Kind in value) return true

	// Additional check: if it's an object with only numeric keys, it's likely a status code map
	const keys = Object.keys(value)
	if (keys.length > 0 && keys.every((k) => !isNaN(Number(k)))) {
		return false
	}

	return false
}

/**
 * Normalize string schema references to TRef nodes for proper merging
 */
const normalizeSchemaReference = (
	schema: TSchema | string | undefined
): TSchema | undefined => {
	if (!schema) return undefined
	if (typeof schema !== 'string') return schema

	// Convert string reference to t.Ref node
	// This allows string aliases to participate in schema composition
	return toRef(schema)
}

/**
 * Merge two schema properties (body, query, headers, params, cookie)
 */
const mergeSchemaProperty = (
	existing: TSchema | string | undefined,
	incoming: TSchema | string | undefined,
	vendors?: MapJsonSchema,
	openapiVersion: OpenAPIVersion = '3.1.2',
	strictSchemaConversion?: StrictSchemaConversion
): TSchema | string | undefined => {
	if (!existing) return incoming
	if (!incoming) return existing

	// Normalize string references to TRef nodes so they can be merged
	let existingSchema = normalizeSchemaReference(existing)
	let incomingSchema = normalizeSchemaReference(incoming)

	if (!existingSchema) return incoming
	if (!incomingSchema) return existing

	if (!isTSchema(incomingSchema) && incomingSchema['~standard'])
		incomingSchema = unwrapSchema(
			incomingSchema,
			vendors,
			'input',
			openapiVersion,
			strictSchemaConversion
		) as any

	if (!isTSchema(existingSchema) && existingSchema['~standard'])
		existingSchema = unwrapSchema(
			existingSchema,
			vendors,
			'input',
			openapiVersion,
			strictSchemaConversion
		) as any

	if (!incomingSchema) return existingSchema
	if (!existingSchema) return incomingSchema

	// If both are object schemas, merge them
	const { schema: mergedSchema, notObjects } = mergeObjectSchemas([
		existingSchema,
		incomingSchema
	])

	// If we have non-object schemas, create an Intersect
	if (notObjects.length > 0) {
		if (mergedSchema) return t.Intersect([mergedSchema, ...notObjects])

		return notObjects.length === 1 ? notObjects[0] : t.Intersect(notObjects)
	}

	return mergedSchema
}

type ResponseSchema =
	| TSchema
	| { [status: number]: TSchema }
	| string
	| { [status: number]: string | TSchema }
	| undefined

const unwrapResponseSchema = (
	schema: ResponseSchema,
	vendors?: MapJsonSchema,
	openapiVersion: OpenAPIVersion = '3.1.2',
	strictSchemaConversion?: StrictSchemaConversion
) =>
	typeof schema === 'string'
		? normalizeSchemaReference(schema)
		: !schema
			? undefined
			: isTSchema(schema)
				? schema
				: // @ts-ignore
					schema['~standard']
					? unwrapSchema(
							schema as any,
							vendors,
							'output',
							openapiVersion,
							strictSchemaConversion
						)
					: Object.fromEntries(
							Object.entries(schema).map(([status, schema]) => [
								status,
								typeof schema === 'string'
									? normalizeSchemaReference(schema)
									: isTSchema(schema)
										? schema
										: unwrapSchema(
												schema as any,
												vendors,
												'output',
												openapiVersion,
												strictSchemaConversion
											)
							])
						)

/**
 * Merge response schemas (handles status code objects)
 */
const mergeResponseSchema = (
	_existing: ResponseSchema,
	_incoming: ResponseSchema,
	vendors?: MapJsonSchema,
	openapiVersion: OpenAPIVersion = '3.1.2',
	strictSchemaConversion?: StrictSchemaConversion
): TSchema | { [status: number]: TSchema | string } | string | undefined => {
	if (!_existing) return _incoming
	if (!_incoming) return _existing

	// Normalize string references to TRef nodes
	let existing = unwrapResponseSchema(
		_existing,
		vendors,
		openapiVersion,
		strictSchemaConversion
	)
	let incoming = unwrapResponseSchema(
		_incoming,
		vendors,
		openapiVersion,
		strictSchemaConversion
	)

	if (!existing && !incoming) return undefined
	if (incoming && !existing) return incoming as any
	if (existing && !incoming) return existing as any

	// @ts-ignore
	if (isTSchema(existing) || existing?.['~standard'])
		existing = {
			200: existing as TSchema
		}

	// @ts-ignore
	if (isTSchema(incoming) || incoming?.['~standard'])
		incoming = {
			200: incoming as TSchema
		}

	const schema: Record<string, unknown> = {
		...incoming
	}

	for (const status of Object.keys(existing ?? {})) {
		const existingSchema = (existing as any)[status]
		const incomingSchema = (incoming as any)[status]

		if (existingSchema && incomingSchema)
			schema[status] = mergeSchemaProperty(
				existingSchema as TSchema,
				incomingSchema as TSchema,
				vendors,
				openapiVersion,
				strictSchemaConversion
			)
		else if (existingSchema) schema[status] = existingSchema
		else if (incomingSchema) schema[status] = incomingSchema
	}

	// Both are status code objects, merge them
	return schema as any
}

/**
 * Merge standaloneValidator array into direct hook properties
 */
const mergeStandaloneValidators = (
	hooks: LocalHook<
		{},
		{
			response: {}
			return: {}
			resolve: {}
		},
		SingletonBase,
		{}
	> & {
		standaloneValidator?: InputSchema[]
	} & InputSchema,
	vendors?: MapJsonSchema,
	openapiVersion: OpenAPIVersion = '3.1.2',
	strictSchemaConversion?: StrictSchemaConversion
) => {
	const merged = { ...hooks }

	if (!hooks.standaloneValidator?.length) return merged

	for (const validator of hooks.standaloneValidator) {
		// Merge each schema property
		if (validator.body)
			merged.body = mergeSchemaProperty(
				merged.body as TSchema,
				validator.body as TSchema,
				vendors,
				openapiVersion,
				strictSchemaConversion
			)

		if (validator.headers)
			merged.headers = mergeSchemaProperty(
				merged.headers as TSchema,
				validator.headers as TSchema,
				vendors,
				openapiVersion,
				strictSchemaConversion
			)

		if (validator.query)
			merged.query = mergeSchemaProperty(
				merged.query as TSchema,
				validator.query as TSchema,
				vendors,
				openapiVersion,
				strictSchemaConversion
			)

		if (validator.params)
			merged.params = mergeSchemaProperty(
				merged.params as TSchema,
				validator.params as TSchema,
				vendors,
				openapiVersion,
				strictSchemaConversion
			)

		if (validator.cookie)
			merged.cookie = mergeSchemaProperty(
				merged.cookie as TSchema,
				validator.cookie as TSchema,
				vendors,
				openapiVersion,
				strictSchemaConversion
			)

		if (validator.response)
			merged.response = mergeResponseSchema(
				merged.response as TSchema,
				validator.response as TSchema,
				vendors,
				openapiVersion,
				strictSchemaConversion
			)
	}

	// Normalize any remaining string references in the final result
	if (typeof merged.body === 'string')
		merged.body = normalizeSchemaReference(merged.body)
	if (typeof merged.headers === 'string')
		merged.headers = normalizeSchemaReference(merged.headers)
	if (typeof merged.query === 'string')
		merged.query = normalizeSchemaReference(merged.query)
	if (typeof merged.params === 'string')
		merged.params = normalizeSchemaReference(merged.params)
	if (typeof merged.cookie === 'string')
		merged.cookie = normalizeSchemaReference(merged.cookie)
	if (merged.response && typeof merged.response !== 'string') {
		// Normalize string references in status code objects
		const response = merged.response as any
		if ('type' in response || '$ref' in response) {
			// It's a schema, not a status code object
			if (typeof response === 'string')
				merged.response = normalizeSchemaReference(response)
		} else {
			// It's a status code object, normalize each value
			for (const [status, schema] of Object.entries(response))
				if (typeof schema === 'string')
					response[status] = normalizeSchemaReference(schema)
		}
	}

	return merged
}

/**
 * Flatten routes by merging guard() schemas into direct hook properties.
 *
 * This makes guard() schemas accessible in the OpenAPI spec by converting
 * the standaloneValidator array into direct hook properties.
 */
const flattenRoutes = (
	routes: any[],
	vendors?: MapJsonSchema,
	openapiVersion: OpenAPIVersion = '3.1.2',
	strictSchemaConversion?: StrictSchemaConversion
): any[] =>
	routes.map((route) => {
		if (!route.hooks?.standaloneValidator?.length) return route

		return {
			...route,
			hooks: mergeStandaloneValidators(
				route.hooks,
				vendors,
				openapiVersion,
				strictSchemaConversion
			)
		}
	})

// ============================================================================

const unwrapReference = <T extends OpenAPIV3.SchemaObject | undefined>(
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
					next[nestedKey] = normalizeNullableSchemaForOAS30(nestedValue)
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

const normalizeNullableSchemaForOAS31 = (schema: unknown): unknown => {
	if (!schema || typeof schema !== 'object') return schema

	if (Array.isArray(schema))
		return schema.map((item) => normalizeNullableSchemaForOAS31(item))

	const normalized = { ...(schema as Record<string, unknown>) }

	const rewriteNullUnion = (key: 'anyOf' | 'oneOf') => {
		if (!Array.isArray(normalized[key])) return

		const entries = normalized[key] as Array<Record<string, unknown>>
		const nullEntries = entries.filter((entry) => entry?.type === 'null')
		if (nullEntries.length === 0) return

		const nonNullEntries = entries.filter((entry) => entry?.type !== 'null')
		if (nonNullEntries.length !== 1) return

		const [nonNull] = nonNullEntries
		const nonNullType = nonNull?.type

		if (typeof nonNullType !== 'string') return

		delete normalized[key]
		Object.assign(normalized, nonNull)
		normalized.type = [nonNullType, 'null']
	}

	rewriteNullUnion('anyOf')
	rewriteNullUnion('oneOf')

	for (const [key, value] of Object.entries(normalized)) {
		if (SCHEMA_OBJECT_MAP_KEYS.has(key)) {
			if (value && typeof value === 'object' && !Array.isArray(value)) {
				const next: Record<string, unknown> = {}
				for (const [nestedKey, nestedValue] of Object.entries(value))
					next[nestedKey] = normalizeNullableSchemaForOAS31(nestedValue)
				normalized[key] = next
			}
			continue
		}

		if (SCHEMA_ARRAY_KEYS.has(key)) {
			if (Array.isArray(value))
				normalized[key] = value.map((item) =>
					normalizeNullableSchemaForOAS31(item)
				)
			continue
		}

		if (SCHEMA_OR_BOOL_KEYS.has(key)) {
			if (value && typeof value === 'object') {
				if (Array.isArray(value))
					normalized[key] = value.map((item) =>
						normalizeNullableSchemaForOAS31(item)
					)
				else normalized[key] = normalizeNullableSchemaForOAS31(value)
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
							? normalizeNullableSchemaForOAS31(nestedValue)
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

	return normalizeNullableSchemaForOAS31(schema) as T
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
	decodeJsonPointerSegment(name).replace(/[^A-Za-z0-9._-]/g, '_') ||
	'Schema'

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

const normalizeOpenAPILocalDefinitions = (
	paths: OpenAPIV3.PathsObject,
	schemas: Record<string, unknown>
) => {
	const components = { ...schemas }

	for (const [name, schema] of Object.entries(components))
		components[name] = normalizeSchemaLocalDefinitions(
			schema,
			components
		)

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

const toResponseHeaders = (
	schema: InputSchema['body'],
	vendors?: MapJsonSchema,
	openapiVersion: OpenAPIVersion = '3.1.2',
	strictSchemaConversion?: StrictSchemaConversion
): Record<string, OpenAPIV3.HeaderObject> | undefined => {
	const headers =
		schema && typeof schema === 'object' && !Array.isArray(schema)
			? (schema as { headers?: TProperties }).headers
			: undefined

	if (!headers) return

	const entries = Object.entries(headers)
		.map(
			([name, headerSchema]) =>
				[
					name,
					{
						schema: unwrapSchema(
							headerSchema as any,
							vendors,
							'output',
							openapiVersion,
							strictSchemaConversion
						)
					}
				] as const
		)
		.filter(([, header]) => header.schema)

	return entries.length ? Object.fromEntries(entries) : undefined
}

const toResponseContentType = (schema: InputSchema['body']) =>
	schema && typeof schema === 'object' && !Array.isArray(schema)
		? (schema as { contentType?: string }).contentType
		: undefined

const toOpenAPIResponseOverride = (schema: InputSchema['body']) =>
	schema && typeof schema === 'object' && !Array.isArray(schema)
		? (schema as { openapiResponse?: OpenAPIV3.ResponseObject })
				.openapiResponse
		: undefined

const stripResponseMetadata = <
	T extends OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject
>(
	schema: T
): T => {
	const { headers, contentType, openapiResponse, ...rest } = schema as T & {
		headers?: unknown
		contentType?: unknown
		openapiResponse?: unknown
	}
	return rest as T
}

const toRequestContentTypes = (schema: InputSchema['body']) => {
	if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return

	const contentType = (
		schema as { requestContentType?: string | string[] }
	).requestContentType

	if (!contentType) return

	return Array.isArray(contentType) ? contentType : [contentType]
}

const stripRequestMetadata = <
	T extends OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject
>(
	schema: T
): T => {
	const { requestContentType, ...rest } = schema as T & {
		requestContentType?: unknown
	}
	return rest as T
}

const VOID_RESPONSE_TYPES = new Set(['void', 'null', 'undefined'])
const PLAIN_RESPONSE_TYPES = new Set([
	'string',
	'number',
	'integer',
	'boolean'
])

const toInferredRequestContent = (
	schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
	type: string | undefined
): OpenAPIV3.RequestBodyObject['content'] =>
	PLAIN_RESPONSE_TYPES.has(type!)
		? { 'text/plain': { schema } }
		: { 'application/json': { schema } }

const toParserRequestContent = (
	parse: unknown,
	schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject
): OpenAPIV3.RequestBodyObject['content'] | undefined => {
	const content: OpenAPIV3.RequestBodyObject['content'] = {}
	const parsers = Array.isArray(parse) ? parse : [parse]

	for (const parser of parsers) {
		const fn =
			parser &&
			typeof parser === 'object' &&
			'fn' in parser
				? (parser as HookContainer).fn
				: parser

		if (typeof fn === 'function') continue

		switch (fn) {
			case 'text':
			case 'text/plain':
				content['text/plain'] = { schema }
				continue

			case 'urlencoded':
			case 'application/x-www-form-urlencoded':
				content['application/x-www-form-urlencoded'] = { schema }
				continue

			case 'json':
			case 'application/json':
				content['application/json'] = { schema }
				continue

			case 'formdata':
			case 'multipart/form-data':
				content['multipart/form-data'] = { schema }
				continue

			case 'none':
				content['application/json'] = { schema }
				content['application/x-www-form-urlencoded'] = { schema }
				content['multipart/form-data'] = { schema }
				content['text/plain'] = { schema }
				continue

			case 'arrayBuffer':
			case 'application/octet-stream':
				content['application/octet-stream'] = { schema }
				continue

			default:
				if (typeof fn === 'string' && fn.includes('/'))
					content[fn] = { schema }
		}
	}

	return Object.keys(content).length ? content : undefined
}

const toRequestContent = (
	schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
	type: string | undefined,
	requestContentTypes: string[] | undefined,
	parse: unknown
): OpenAPIV3.RequestBodyObject['content'] => {
	if (requestContentTypes?.length)
		return Object.fromEntries(
			requestContentTypes.map((contentType) => [
				contentType,
				{ schema }
			])
		)

	return (
		toParserRequestContent(parse, schema) ??
		toInferredRequestContent(schema, type)
	)
}

const mergeOpenAPIEncodingObject = (
	base: OpenAPIV3.EncodingObject | undefined,
	incoming: OpenAPIV3.EncodingObject | undefined
) => {
	if (!base) return incoming
	if (!incoming) return base

	return {
		...base,
		...incoming,
		...(base.headers || incoming.headers
			? {
					headers: {
						...base.headers,
						...incoming.headers
					}
				}
			: {})
	} satisfies OpenAPIV3.EncodingObject
}

const mergeOpenAPIMediaTypeObject = (
	base: OpenAPIV3.MediaTypeObject | undefined,
	incoming: OpenAPIV3.MediaTypeObject | undefined
) => {
	if (!base) return incoming
	if (!incoming) return base

	let encoding: OpenAPIV3.MediaTypeObject['encoding'] | undefined

	if (base.encoding || incoming.encoding) {
		encoding = {}

		for (const property of new Set([
			...Object.keys(base.encoding ?? {}),
			...Object.keys(incoming.encoding ?? {})
		])) {
			const merged = mergeOpenAPIEncodingObject(
				base.encoding?.[property],
				incoming.encoding?.[property]
			)

			if (merged) encoding[property] = merged
		}
	}

	return {
		...base,
		...incoming,
		...(base.examples || incoming.examples
			? {
					examples: {
						...base.examples,
						...incoming.examples
					}
				}
			: {}),
		...(encoding ? { encoding } : {})
	} satisfies OpenAPIV3.MediaTypeObject
}

const mergeOpenAPIContent = (
	base: OpenAPIV3.ResponseObject['content'] | undefined,
	incoming: OpenAPIV3.ResponseObject['content'] | undefined
) => {
	if (!base) return incoming
	if (!incoming) return base

	const content = { ...base }

	for (const [contentType, mediaType] of Object.entries(incoming))
		content[contentType] = mergeOpenAPIMediaTypeObject(
			content[contentType],
			mediaType
		)!

	return content
}

const mergeOpenAPIRequestBodyObject = (
	base: OpenAPIV3.RequestBodyObject | OpenAPIV3.ReferenceObject | undefined,
	incoming:
		| OpenAPIV3.RequestBodyObject
		| OpenAPIV3.ReferenceObject
		| undefined
) => {
	if (!base) return incoming
	if (!incoming) return base
	if ('$ref' in base || '$ref' in incoming) return incoming

	return {
		...base,
		...incoming,
		...(base.content || incoming.content
			? {
					content: mergeOpenAPIContent(
						base.content,
						incoming.content
					)
				}
			: {})
	} satisfies OpenAPIV3.RequestBodyObject
}

const toResponseContent = (
	schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
	type: string | undefined,
	contentType: string | undefined,
	description: string | undefined
): OpenAPIV3.ResponseObject['content'] | undefined =>
	VOID_RESPONSE_TYPES.has(type!)
		? undefined
		: contentType
			? { [contentType]: { schema } }
		: PLAIN_RESPONSE_TYPES.has(type!)
			? { 'text/plain': { schema } }
			: { 'application/json': { schema } }

const toResponseObject = (
	schema: InputSchema['body'],
	status: string,
	definitions: Record<string, unknown>,
	vendors?: MapJsonSchema,
	openapiVersion: OpenAPIVersion = '3.1.2',
	strictSchemaConversion?: StrictSchemaConversion
): OpenAPIV3.ResponseObject | undefined => {
	const response = unwrapSchema(
		schema,
		vendors,
		'output',
		openapiVersion,
		strictSchemaConversion
	)
	if (!response) return

	const contentType =
		toResponseContentType(schema) ?? toResponseContentType(response as any)
	const responseSchema = stripResponseMetadata(response)
	const responseOverride =
		toOpenAPIResponseOverride(schema) ??
		toOpenAPIResponseOverride(response as any)
	// @ts-ignore Must exclude $ref from root options
	const { type, description } = unwrapReference(responseSchema, definitions)
	const headers = toResponseHeaders(
		schema,
		vendors,
		openapiVersion,
		strictSchemaConversion
	)
	const content = toResponseContent(
		responseSchema,
		type,
		contentType,
		description
	)

	const generated = {
		description: description ?? `Response for status ${status}`,
		...(headers ? { headers } : {}),
		...(content ? { content } : {})
	}

	return mergeOpenAPIResponseObject(generated, responseOverride) as
		| OpenAPIV3.ResponseObject
		| undefined
}

const mergeOpenAPIResponseObject = (
	base: OpenAPIV3.ResponseObject | OpenAPIV3.ReferenceObject | undefined,
	incoming: OpenAPIV3.ResponseObject | OpenAPIV3.ReferenceObject | undefined
) => {
	if (!base) return incoming
	if (!incoming) return base
	if ('$ref' in base || '$ref' in incoming) return incoming

	return {
		...base,
		...incoming,
		...(base.headers || incoming.headers
			? {
					headers: {
						...base.headers,
						...incoming.headers
					}
				}
			: {}),
		...(base.content || incoming.content
			? {
					content: mergeOpenAPIContent(
						base.content,
						incoming.content
					)
				}
			: {})
	} satisfies OpenAPIV3.ResponseObject
}

const mergeOpenAPIResponses = (
	base: OpenAPIV3.ResponsesObject | undefined,
	incoming: OpenAPIV3.ResponsesObject | undefined
): OpenAPIV3.ResponsesObject | undefined => {
	if (!base) return incoming
	if (!incoming) return base

	const responses: OpenAPIV3.ResponsesObject = { ...base }

	for (const [status, response] of Object.entries(incoming))
		responses[status] = mergeOpenAPIResponseObject(
			responses[status],
			response
		) as any

	return responses
}

const mergeOperationDetail = (
	base: Partial<OpenAPIV3.OperationObject> | undefined,
	incoming: Partial<OpenAPIV3.OperationObject> | undefined
): Partial<OpenAPIV3.OperationObject> => {
	if (!base) return incoming ?? {}
	if (!incoming) return base

	const responses = mergeOpenAPIResponses(base.responses, incoming.responses)
	const requestBody = mergeOpenAPIRequestBodyObject(
		base.requestBody,
		incoming.requestBody
	)

	return {
		...base,
		...incoming,
		...(responses ? { responses } : {}),
		...(requestBody ? { requestBody } : {})
	}
}

const isLikelyStaticFilePath = (path: string) => {
	const segment = path.split('/').pop()
	if (!segment) return false

	const dotIndex = segment.lastIndexOf('.')
	if (dotIndex <= 0 || dotIndex === segment.length - 1) return false

	const extension = segment.slice(dotIndex + 1)
	return /^[A-Za-z][A-Za-z0-9]{0,15}$/.test(extension)
}

/**
 * Converts Elysia routes to OpenAPI 3.0.3 paths schema
 * @param routes Array of Elysia route objects
 * @returns OpenAPI paths object
 */
export function toOpenAPISchema(
	app: AnyElysia,
	exclude?: ElysiaOpenAPIConfig['exclude'],
	references?: AdditionalReferences,
	vendors?: MapJsonSchema,
	openapiVersion: OpenAPIVersion = '3.1.2',
	options?: {
		strictSchemaConversion?: StrictSchemaConversion
	}
) {
	const strictSchemaConversion = options?.strictSchemaConversion
	let {
		methods: excludeMethods = ['options'],
		staticFile: excludeStaticFile = true,
		tags: excludeTags
	} = exclude ?? {}

	excludeMethods = excludeMethods.map((method) => method.toLowerCase())

	const excludePaths = Array.isArray(exclude?.paths)
		? exclude.paths
		: typeof exclude?.paths !== 'undefined'
			? [exclude.paths]
			: []

	const ignorePatterns: RegExp[] = excludePaths.filter(
		(path): path is RegExp => path instanceof RegExp
	)

	const paths: OpenAPIV3.PathsObject = Object.create(null)
	const operationIds = new Map<string, number>()
	// @ts-ignore
	const definitions = app.getGlobalDefinitions?.().type

	if (references) {
		if (!Array.isArray(references)) references = [references]

		for (let i = 0; i < references.length; i++) {
			const reference = references[i]

			if (typeof reference === 'function') references[i] = reference()
		}
	}

	// Flatten routes to merge guard() schemas into direct hook properties
	// This makes guard schemas accessible for OpenAPI documentation generation
	// @ts-ignore private property
	const routes = flattenRoutes(
		(app as any).getGlobalRoutes(),
		vendors,
		openapiVersion,
		strictSchemaConversion
	)
	for (const route of routes) {
		if (route.hooks?.detail?.hide) continue

		const method = route.method.toLowerCase()
		const shouldExclude = ignorePatterns.some((pattern) => {
			pattern.lastIndex = 0
			return pattern.test(route.path)
		})

		if (
			(method !== 'all' && !OPENAPI_HTTP_METHODS.has(method)) ||
			(excludeStaticFile && isLikelyStaticFilePath(route.path)) ||
			excludePaths.includes(route.path) ||
			excludeMethods.includes(method) ||
			shouldExclude
		)
			continue

		const hooks: InputSchema & {
			detail?: Partial<OpenAPIV3.OperationObject>
			parse?: unknown
		} = route.hooks ?? {}
		let referenceDetail: Partial<OpenAPIV3.OperationObject> | undefined

		if (references?.length)
			for (const reference of references as AdditionalReference[]) {
				if (!reference) continue

				const refer =
					reference[route.path]?.[method] ??
					reference[getLoosePath(route.path)]?.[method]

				if (!refer) continue

				if (refer.detail)
					referenceDetail = mergeOperationDetail(
						referenceDetail,
						refer.detail
					)

				if (!hooks.body && isReferenceSchema(refer.body))
					hooks.body = refer.body

				if (!hooks.query && isReferenceSchema(refer.query))
					hooks.query = refer.query

				if (!hooks.params && isReferenceSchema(refer.params))
					hooks.params = refer.params

				if (!hooks.headers && isReferenceSchema(refer.headers))
					hooks.headers = refer.headers

				if (refer.response)
					for (const [status, schema] of Object.entries(
						refer.response
					))
						if (isReferenceSchema(schema)) {
							if (!hooks.response) hooks.response = {}
							else if (
								typeof hooks.response !== 'object' ||
								(hooks.response as TSchema).type ||
								(hooks.response as TSchema).$ref ||
								(hooks.response as any)['~standard']
							)
								hooks.response = {
									200: hooks.response as any
								}

							if (
								!hooks.response[
									status as keyof (typeof hooks)['response']
								]
							)
								try {
									// @ts-ignore
									hooks.response[status] = schema
								} catch (error) {
									console.log(
										'[@onreza/elysia-openapi/gen] Failed to assigned response schema'
									)
									console.log(error)
								}
						}
			}

		if (
			excludeTags &&
			hooks.detail?.tags?.some((tag) => excludeTags?.includes(tag))
		)
			continue

		// Start building the operation object
		const operation = mergeOperationDetail(referenceDetail, hooks.detail)

		const parameters: Array<{
			name: string
			in: 'path' | 'query' | 'header' | 'cookie'
			required?: boolean
			schema: any
		}> = []

		// Handle path parameters
		if (hooks.params) {
			const params = unwrapReference(
				unwrapSchema(
					hooks.params,
					vendors,
					'input',
					openapiVersion,
					strictSchemaConversion
				),
				definitions
			)

			if (params && params.type === 'object' && params.properties)
				for (const [name, schema] of Object.entries(params.properties))
					parameters.push({
						name,
						in: 'path',
						required: true, // Path parameters are always required
						schema
					})
		} else {
			for (const match of route.path.matchAll(/:([^/]+)/g)) {
				const name = match[1].replace('?', '')

				parameters.push({
					name,
					in: 'path',
					required: true,
					schema: { type: 'string' }
				})
			}
		}

		// Handle query parameters
		if (hooks.query) {
			const query = unwrapReference(
				unwrapSchema(
					hooks.query,
					vendors,
					'input',
					openapiVersion,
					strictSchemaConversion
				),
				definitions
			)

			if (query && query.type === 'object' && query.properties) {
				const required = query.required || []
				for (const [name, schema] of Object.entries(query.properties))
					parameters.push({
						name,
						in: 'query',
						required: required.includes(name),
						schema
					})
			}
		}

		// Handle header parameters
		if (hooks.headers) {
			const headers = unwrapReference(
				unwrapSchema(
					hooks.headers,
					vendors,
					'input',
					openapiVersion,
					strictSchemaConversion
				),
				definitions
			)

			if (headers && headers.type === 'object' && headers.properties) {
				const required = headers.required || []
				for (const [name, schema] of Object.entries(headers.properties))
					parameters.push({
						name,
						in: 'header',
						required: required.includes(name),
						schema
					})
			}
		}

		// Handle cookie parameters
		if (hooks.cookie) {
			const cookie = unwrapReference(
				unwrapSchema(
					hooks.cookie,
					vendors,
					'input',
					openapiVersion,
					strictSchemaConversion
				),
				definitions
			)

			if (cookie && cookie.type === 'object' && cookie.properties) {
				const required = cookie.required || []
				for (const [name, schema] of Object.entries(cookie.properties))
					parameters.push({
						name,
						in: 'cookie',
						required: required.includes(name),
						schema
					})
			}
		}

		// Add parameters if any exist
		if (parameters.length > 0)
			operation.parameters = [
				...(operation.parameters ?? []),
				...parameters
			]

		// Handle request body
		if (hooks.body && method !== 'get' && method !== 'head') {
			const body = unwrapSchema(
				hooks.body,
				vendors,
				'input',
				openapiVersion,
				strictSchemaConversion
			)

			if (body) {
				const requestContentTypes =
					toRequestContentTypes(hooks.body) ??
					toRequestContentTypes(body as any)
				const bodySchema = stripRequestMetadata(body)
				// @ts-ignore
				const { type, description } = unwrapReference(
					bodySchema,
					definitions
				)
				const generatedRequestBody = {
					description,
					required: true,
					content: toRequestContent(
						bodySchema,
						type,
						requestContentTypes,
						hooks.parse
					)
				} satisfies OpenAPIV3.RequestBodyObject

				operation.requestBody = mergeOpenAPIRequestBodyObject(
					generatedRequestBody,
					operation.requestBody
				)
			}
		}

		// Handle responses
		if (hooks.response) {
			operation.responses = { ...(operation.responses ?? {}) }

			if (
				typeof hooks.response === 'object' &&
				!(Kind in (hooks.response as object)) &&
				// TypeBox
				!(hooks.response as TSchema).type &&
				!(hooks.response as TSchema).$ref &&
				!(hooks.response as any)['~standard']
			) {
				for (let [status, schema] of Object.entries(hooks.response)) {
					const response = toResponseObject(
						schema as InputSchema['body'],
						status,
						definitions,
						vendors,
						openapiVersion,
						strictSchemaConversion
					)

					if (response)
						operation.responses[status] = mergeOpenAPIResponseObject(
							response,
							operation.responses[status]
						) as any
				}
			} else {
				const response = toResponseObject(
					hooks.response as any,
					'200',
					definitions,
					vendors,
					openapiVersion,
					strictSchemaConversion
				)

				if (response)
					operation.responses['200'] = mergeOpenAPIResponseObject(
						response,
						operation.responses['200']
					) as any
			}
		}

		for (let path of getPossiblePath(route.path)) {
			const operationId =
				operation.operationId ?? toOperationId(route.method, path)

			path = path.replace(/:([^/]+)/g, '{$1}')

			if (!paths[path]) paths[path] = {}

			const current = paths[path] as any

			if (method !== 'all') {
				current[method] = {
					...operation,
					operationId: uniqueOperationId(operationId, operationIds)
				}
				continue
			}

			// Handle 'ALL' method by assigning operation to all standard methods
			for (const method of [
				'get',
				'post',
				'put',
				'delete',
				'patch',
				'head',
				'options',
				'trace'
			])
				current[method] = {
					...operation,
					operationId: uniqueOperationId(operationId, operationIds)
				}
		}
	}

	// @ts-ignore private property
	const schemas = Object.create(null)

	if (definitions)
		for (const [name, schema] of Object.entries(definitions)) {
				const jsonSchema = unwrapSchema(
					schema as any,
					vendors,
					'input',
					openapiVersion,
					strictSchemaConversion
				) as
				| OpenAPIV3.SchemaObject
				| undefined

			if (jsonSchema) schemas[name] = jsonSchema
		}

	const normalized = normalizeOpenAPILocalDefinitions(paths, schemas)

	return {
		components: {
			schemas: normalized.schemas as NonNullable<
				OpenAPIV3.ComponentsObject['schemas']
			>
		},
		paths: normalized.paths
	} satisfies Pick<OpenAPIV3.Document, 'paths' | 'components'>
}

const cloneResponseSchema = <S extends object>(schema: S) => {
	const clone = Object.create(
		Object.getPrototypeOf(schema),
		Object.getOwnPropertyDescriptors(schema)
	) as S

	return clone
}

export const withHeaders = <S extends TSchema, H extends TProperties>(
	schema: S,
	headers: H
) => {
	const clone = cloneResponseSchema(schema) as S & { headers: H }

	clone.headers = headers

	return clone
}

export const withContentType = <S extends TSchema>(
	schema: S,
	contentType: string
) => {
	const clone = cloneResponseSchema(schema) as S & { contentType: string }

	clone.contentType = contentType

	return clone
}

export const withResponse = <S extends TSchema>(
	schema: S,
	response: Partial<OpenAPIV3.ResponseObject> & { contentType?: string }
) => {
	const clone = cloneResponseSchema(schema) as S & {
		contentType?: string
		openapiResponse?: OpenAPIV3.ResponseObject
	}
	const { contentType, ...openapiResponse } = response

	if (contentType) clone.contentType = contentType
	clone.openapiResponse = openapiResponse as OpenAPIV3.ResponseObject

	return clone
}

export const withRequestContentType = <S extends object>(
	schema: S,
	contentType: string | string[]
) => {
	const clone = cloneResponseSchema(schema) as S & {
		requestContentType: string | string[]
	}

	clone.requestContentType = contentType

	return clone
}

export const withOpenAPISchema = <S extends object>(
	schema: S,
	metadata: OpenAPISchemaMetadata
) => {
	const clone = cloneResponseSchema(schema) as S & {
		openapiSchema: OpenAPISchemaMetadata
	}

	clone.openapiSchema = metadata

	return clone
}

export const withDiscriminator = <S extends object>(
	schema: S,
	discriminator: OpenAPIV3.DiscriminatorObject
) =>
	withOpenAPISchema(schema, {
		discriminator
	})

export const withBinaryResponse = (
	contentType = 'application/octet-stream',
	options?: Parameters<typeof t.String>[0]
) =>
	withContentType(
		t.String({
			...options,
			format: options?.format ?? 'binary'
		}),
		contentType
	)
