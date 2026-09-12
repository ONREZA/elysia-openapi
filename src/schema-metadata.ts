import { t, type TSchema } from 'elysia'
import type { TProperties } from '@sinclair/typebox'
import type { OpenAPIV3 } from 'openapi-types'
import type { OpenAPISchemaMetadata } from './schema-conversion'

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
