import type { TSchema } from 'elysia'
import type { OpenAPIV3, OpenAPIV3_1 } from 'openapi-types'
import type { ApiReferenceConfiguration } from '@scalar/types'
import type { SwaggerUIOptions } from './swagger/types'

export type OpenAPIProvider = 'scalar' | 'swagger-ui' | null
export type OpenAPIVersion = `3.0.${number}` | `3.1.${number}`
export type JsonSchemaTarget =
	| 'draft-2020-12'
	| 'draft-07'
	| 'openapi-3.0'
	| (string & {})
export type StrictSchemaConversion = boolean | 'warn'
export type JsonSchemaConversionContext = {
	vendor: string
	io: 'input' | 'output'
	typeMode: 'input' | 'output'
	openapiVersion: OpenAPIVersion
	target: JsonSchemaTarget
	strictSchemaConversion?: StrictSchemaConversion
}
export type JsonSchemaMapper = (
	schema: any,
	context: JsonSchemaConversionContext
) => unknown

type MaybeArray<T> = T | T[]
type OpenAPITagGroup = {
	name: string
	tags: string[]
}

export type OpenAPIDocumentation = Omit<
	Partial<OpenAPIV3.Document> & Partial<OpenAPIV3_1.Document>,
	| 'x-express-openapi-additional-middleware'
	| 'x-express-openapi-validation-strict'
> & {
	/**
	 * Group tags in Scalar UI using the `x-tagGroups` extension.
	 */
	'x-tagGroups'?: OpenAPITagGroup[]
}

export type MapJsonSchema = { [vendor: string]: JsonSchemaMapper } & {
	[vendor in  // schema['~standard'].vendor
		| 'zod'
		| 'effect'
		| 'valibot'
		| 'arktype'
		| 'typemap'
		| 'yup'
		| 'joi']?: JsonSchemaMapper
}

export type AdditionalReference = {
	[path in string]: {
		[method in string]: {
			params?: TSchema | string
			query?: TSchema | string
			headers?: TSchema | string
			body?: TSchema | string
			response?: { [status in number | string]: TSchema | string }
			detail?: Partial<OpenAPIV3.OperationObject>
		}
	}
}

export type AdditionalReferences = MaybeArray<
	AdditionalReference | undefined | (() => AdditionalReference | undefined)
>

export interface ElysiaOpenAPIConfig<
	Enabled extends boolean = true,
	Path extends string = '/swagger'
> {
	/**
	 * @default true
	 */
	enabled?: Enabled

	/**
	 * OpenAPI document version to emit
	 *
	 * Supports OpenAPI 3.0.x and 3.1.x
	 *
	 * @default '3.1.2'
	 */
	openapiVersion?: OpenAPIVersion

	/**
	 * OpenAPI config
	 *
	 * @see https://spec.openapis.org/oas/latest.html
	 */
	documentation?: OpenAPIDocumentation

	exclude?: {
		/**
		 * Exclude methods from OpenAPI
		 */
		methods?: string[]

		/**
		 * Paths to exclude from OpenAPI endpoint
		 *
		 * @default []
		 */
		paths?: string | RegExp | (string | RegExp)[]

		/**
		 * Determine if OpenAPI should exclude static files.
		 *
		 * @default true
		 */
		staticFile?: boolean

		/**
		 * Exclude tags from OpenAPI
		 */
		tags?: string[]
	}

	/**
	 * The endpoint to expose OpenAPI Documentation
	 *
	 * @default '/openapi'
	 */
	path?: Path

	/**
	 * Choose your provider, Scalar or Swagger UI
	 *
	 * @default 'scalar'
	 * @see https://github.com/scalar/scalar
	 * @see https://github.com/swagger-api/swagger-ui
	 */
	provider?: OpenAPIProvider

	/**
	 * Additional reference for each endpoint
	 */
	references?: AdditionalReferences

	/**
	 * Embed OpenAPI schema to provider body if possible
	 *
	 * This is highly discouraged, unless you really have to inline OpenAPI schema
	 *
	 * @default false
	 */
	embedSpec?: boolean

	/**
	 * Mapping function from Standard Schema-compatible validators to JSON Schema.
	 * Mapper functions receive `(schema, context)`, where `context.target` is
	 * `draft-2020-12` for OpenAPI 3.1 and `openapi-3.0` for OpenAPI 3.0.
	 * `context.io` / `context.typeMode` is `input` for requests and `output`
	 * for responses.
	 *
	 * @example
	 * ```ts
	 * import { openapi } from '@onreza/elysia-openapi'
	 * import { toJsonSchema } from '@valibot/to-json-schema'
	 *
	 * openapi({
	 * 	mapJsonSchema: {
	 * 	  valibot: toJsonSchema
	 *   }
	 * })
	 */
	mapJsonSchema?: MapJsonSchema

	/**
	 * Controls JSON Schema conversion diagnostics for Standard Schema and
	 * mapJsonSchema converters.
	 *
	 * - `true`: throw when conversion fails or returns an empty schema object.
	 * - `'warn'`: warn for empty schema objects, but keep generating the spec.
	 * - `false` / undefined: preserve the historical best-effort behavior.
	 */
	strictSchemaConversion?: StrictSchemaConversion

	/**
	 * Scalar configuration to customize scalar
	 *'
	 * @see https://github.com/scalar/scalar/blob/main/documentation/configuration.md
	 */
	scalar?: ApiReferenceConfiguration & {
		/**
		 * Version to use for Scalar cdn bundle
		 *
		 * @default 'latest'
		 * @see https://github.com/scalar/scalar
		 */
		version?: string
		/**
		 * Optional override to specifying the path for the Scalar bundle
		 *
		 * Custom URL or path to locally hosted Scalar bundle
		 *
		 * Lease blank to use default jsdeliver.net CDN
		 *
		 * @default ''
		 * @example 'https://unpkg.com/@scalar/api-reference@1.13.10/dist/browser/standalone.js'
		 * @example '/public/standalone.js'
		 * @see https://github.com/scalar/scalar
		 */
		cdn?: string
	}
	/**
	 * The endpoint to expose OpenAPI JSON specification
	 *
	 * @default '/${path}/json'
	 */
	specPath?: string

	/**
	 * Options to send to SwaggerUIBundle
	 * Currently, options that are defined as functions such as requestInterceptor
	 * and onComplete are not supported.
	 */
	swagger?: Omit<
		Partial<SwaggerUIOptions>,
		| 'dom_id'
		| 'dom_node'
		| 'spec'
		| 'url'
		| 'urls'
		| 'layout'
		| 'pluginsOptions'
		| 'plugins'
		| 'presets'
		| 'onComplete'
		| 'requestInterceptor'
		| 'responseInterceptor'
		| 'modelPropertyMacro'
		| 'parameterMacro'
	> & {
		/**
		 * Custom Swagger CSS
		 */
		theme?:
			| string
			| {
					light: string
					dark: string
			  }

		/**
		 * Version to use for swagger cdn bundle
		 *
		 * @see unpkg.com/swagger-ui-dist
		 *
		 * @default 4.18.2
		 */
		version?: string

		/**
		 * Using poor man dark mode 😭
		 */
		autoDarkMode?: boolean

		/**
		 * Optional override to specifying the path for the Swagger UI bundle
		 * Custom URL or path to locally hosted Swagger UI bundle
		 */
		cdn?: string
	}
}
