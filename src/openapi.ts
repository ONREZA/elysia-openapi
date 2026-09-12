import {
	componentRef,
	unwrapReference,
	unwrapSchema,
	normalizeOpenAPILocalDefinitions,
	type OpenAPISchemaMetadata
} from './schema-conversion'
export {
	componentRef,
	unwrapSchema,
	nullToOpenApi,
	enumToOpenApi,
	type OpenAPISchemaMetadata
} from './schema-conversion'
import { t, type AnyElysia, type TSchema, type InputSchema } from 'elysia'
import type {
	HookContainer,
	LocalHook,
	RouteSchema,
	SingletonBase,
	StandardSchemaV1Like
} from 'elysia/types'

import type { OpenAPIV3 } from 'openapi-types'
import { Kind, type TProperties, type TObject } from '@sinclair/typebox'

import type {
	AdditionalReference,
	AdditionalReferences,
	ElysiaOpenAPIConfig,
	MapJsonSchema,
	OpenAPIVersion,
	StrictSchemaConversion
} from './types'

export const capitalize = (word: string) =>
	word.charAt(0).toUpperCase() + word.slice(1)

const toRef = componentRef

const toOperationIdSegment = (segment: string) => {
	if (!segment) return ''

	const isParam = segment.startsWith(':')
	const raw = segment.replace(/^:/, '').replace(/\?$/, '')
	const optional = segment.endsWith('?')
	const name = (raw.match(/[A-Za-z0-9]+/g) ?? []).map(capitalize).join('')

	if (!name) return ''

	return `${isParam ? 'By' : ''}${name}${optional ? 'Optional' : ''}`
}

const toOperationId = (method: string, paths: string) => {
	const prefix = method.toLowerCase()

	if (!paths || paths === '/') return prefix + 'Index'

	const segments = paths.split('/').map(toOperationIdSegment).filter(Boolean)

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

	const contentType = (schema as { requestContentType?: string | string[] })
		.requestContentType

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
const PLAIN_RESPONSE_TYPES = new Set(['string', 'number', 'integer', 'boolean'])

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
			parser && typeof parser === 'object' && 'fn' in parser
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
			requestContentTypes.map((contentType) => [contentType, { schema }])
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
					content: mergeOpenAPIContent(base.content, incoming.content)
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
					content: mergeOpenAPIContent(base.content, incoming.content)
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
						operation.responses[status] =
							mergeOpenAPIResponseObject(
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
			) as OpenAPIV3.SchemaObject | undefined

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

export {
	withHeaders,
	withContentType,
	withResponse,
	withRequestContentType,
	withOpenAPISchema,
	withDiscriminator,
	withBinaryResponse
} from './schema-metadata'
