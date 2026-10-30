using System.Net;
using System.Net.Sockets;
using Azure.Messaging.ServiceBus;

namespace Vectora.Api.Middleware;

/// <summary>
/// Global exception handling middleware to prevent leaking stack traces and internal errors.
/// </summary>
public class ExceptionHandlingMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<ExceptionHandlingMiddleware> _logger;
    private readonly IHostEnvironment _environment;

    public ExceptionHandlingMiddleware(
        RequestDelegate next,
        ILogger<ExceptionHandlingMiddleware> logger,
        IHostEnvironment environment)
    {
        _next = next;
        _logger = logger;
        _environment = environment;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        try
        {
            await _next(context);
        }
        catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested)
        {
            // Client disconnected - don't log as error
            context.Response.StatusCode = 499; // Client Closed Request
        }
        catch (ServiceBusException sbEx) when (sbEx.Reason == ServiceBusFailureReason.MessagingEntityNotFound)
        {
            // Entity not found - log as warning, not error
            _logger.LogWarning("Service Bus entity not found: {Message}", sbEx.Message);
            await HandleExceptionAsync(context, sbEx, HttpStatusCode.NotFound, "Queue, topic, or subscription not found");
        }
        catch (ServiceBusException sbEx) when (sbEx.Reason == ServiceBusFailureReason.MessagingEntityAlreadyExists)
        {
            _logger.LogWarning("Service Bus entity already exists: {Message}", sbEx.Message);
            await HandleExceptionAsync(context, sbEx, HttpStatusCode.Conflict,
                "An entity with this name already exists. Queue and topic names must be unique within the namespace.");
        }
        catch (UnauthorizedAccessException uaEx)
        {
            // A bad connection-string key surfaces here (the Service Bus SDK throws this when token
            // authorization fails). It is a downstream failure, so report 502 - never 401. A 401
            // would be read by the SPA as "your app session expired", which clears the token and
            // reloads the page, looping forever against a wrong key.
            _logger.LogWarning("Service Bus authorization failed for request {Method} {Path}: {Message}",
                context.Request.Method, context.Request.Path, uaEx.Message);
            await HandleExceptionAsync(context, uaEx, HttpStatusCode.BadGateway, "Service Bus authorization failed. Check the connection string's shared access key.");
        }
        catch (ServiceBusException sbEx)
        {
            // Other Service Bus errors
            _logger.LogError(sbEx, "Service Bus error for request {Method} {Path}",
                context.Request.Method, context.Request.Path);
            await HandleExceptionAsync(context, sbEx, HttpStatusCode.BadGateway, "Service Bus error");
        }
        catch (Exception ex) when (IsConnectionFailure(ex))
        {
            // The administration API is HTTP, so an unreachable host surfaces as a socket error
            // wrapped by the Azure.Core retry pipeline rather than as a ServiceBusException. The
            // common cause is an emulator that isn't running, or one too old to serve the
            // management API, so say that instead of reporting a generic 500.
            _logger.LogWarning(ex, "Could not reach the Service Bus management API for request {Method} {Path}",
                context.Request.Method, context.Request.Path);
            await HandleExceptionAsync(context, ex, HttpStatusCode.BadGateway,
                "Could not reach the Service Bus management API. If this is an emulator, check that it is running and that it serves the management API (Azure Service Bus Emulator with SDK 7.20 or newer, admin port 5300 by default).");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Unhandled exception for request {Method} {Path}",
                context.Request.Method, context.Request.Path);

            await HandleExceptionAsync(context, ex);
        }
    }

    // A dead host reaches us as a socket error (connection refused) or a network timeout (traffic
    // silently dropped), wrapped in the AggregateException that Azure.Core throws once its retry
    // budget is spent. A bare cancellation is deliberately NOT matched here: that is a client
    // disconnect, handled as 499 by the first catch above.
    private static bool IsConnectionFailure(Exception exception) => exception switch
    {
        SocketException or HttpRequestException or TimeoutException => true,
        AggregateException agg => agg.InnerExceptions.Any(e => e is TaskCanceledException || IsConnectionFailure(e)),
        _ => exception.InnerException is { } inner && IsConnectionFailure(inner),
    };

    private async Task HandleExceptionAsync(HttpContext context, Exception exception, HttpStatusCode? overrideStatus = null, string? overrideMessage = null)
    {
        context.Response.ContentType = "application/json";

        var (statusCode, message) = (overrideStatus, overrideMessage) switch
        {
            (not null, not null) => (overrideStatus.Value, overrideMessage),
            _ => exception switch
            {
                ArgumentException => (HttpStatusCode.BadRequest, "Invalid request parameters"),
                KeyNotFoundException => (HttpStatusCode.NotFound, "Resource not found"),
                InvalidOperationException => (HttpStatusCode.BadRequest, "Invalid operation"),
                _ => (HttpStatusCode.InternalServerError, "An unexpected error occurred")
            }
        };

        context.Response.StatusCode = (int)statusCode;

        var response = new
        {
            error = message,
            // Only include details in development
            details = _environment.IsDevelopment() ? exception.Message : null
        };

        await context.Response.WriteAsJsonAsync(response);
    }
}
