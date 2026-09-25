using Microsoft.AspNetCore.Mvc;
using Vectora.Api.Helpers;
using Vectora.Api.Models;
using Vectora.Api.Services;

namespace Vectora.Api.Endpoints;

public static class ServiceBusMessageEndpoints
{
    public static void MapServiceBusMessageEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/connections/{connectionId:int}/servicebus").WithTags("ServiceBusMessages");

        // Peek operations
        group.MapGet("/queues/{queueName}/messages", PeekQueueMessages)
            .WithName("PeekQueueMessages");

        group.MapGet("/topics/{topicName}/subscriptions/{subscriptionName}/messages", PeekSubscriptionMessages)
            .WithName("PeekSubscriptionMessages");

        // Session operations (read-only peek; group by session id and browse a single session)
        group.MapGet("/queues/{queueName}/sessions", ScanQueueSessions)
            .WithName("ScanQueueSessions");

        group.MapGet("/topics/{topicName}/subscriptions/{subscriptionName}/sessions", ScanSubscriptionSessions)
            .WithName("ScanSubscriptionSessions");

        group.MapGet("/queues/{queueName}/sessions/messages", PeekQueueSessionMessages)
            .WithName("PeekQueueSessionMessages");

        group.MapGet("/topics/{topicName}/subscriptions/{subscriptionName}/sessions/messages", PeekSubscriptionSessionMessages)
            .WithName("PeekSubscriptionSessionMessages");

        // Receive operations
        group.MapPost("/queues/{queueName}/messages/receive", ReceiveQueueMessages)
            .WithName("ReceiveQueueMessages");

        group.MapPost("/topics/{topicName}/subscriptions/{subscriptionName}/messages/receive", ReceiveSubscriptionMessages)
            .WithName("ReceiveSubscriptionMessages");

        // Send operations
        group.MapPost("/queues/{queueName}/messages", SendToQueue)
            .WithName("SendToQueue");

        group.MapPost("/topics/{topicName}/messages", SendToTopic)
            .WithName("SendToTopic");

        // Dead letter return operations
        group.MapPost("/queues/{queueName}/deadletter/{sequenceNumber}/return", ReturnQueueDeadLetter)
            .WithName("ReturnQueueDeadLetter");

        group.MapPost("/topics/{topicName}/subscriptions/{subscriptionName}/deadletter/{sequenceNumber}/return", ReturnSubscriptionDeadLetter)
            .WithName("ReturnSubscriptionDeadLetter");

        group.MapPost("/queues/{queueName}/deadletter/return/batch", ReturnQueueDeadLetterBatch)
            .WithName("ReturnQueueDeadLetterBatch");

        group.MapPost("/topics/{topicName}/subscriptions/{subscriptionName}/deadletter/return/batch", ReturnSubscriptionDeadLetterBatch)
            .WithName("ReturnSubscriptionDeadLetterBatch");

        // Dead letter consume operations (delete selected messages from DLQ)
        group.MapPost("/queues/{queueName}/deadletter/receive/batch", ReceiveQueueDeadLetterBatch)
            .WithName("ReceiveQueueDeadLetterBatch");

        group.MapPost("/topics/{topicName}/subscriptions/{subscriptionName}/deadletter/receive/batch", ReceiveSubscriptionDeadLetterBatch)
            .WithName("ReceiveSubscriptionDeadLetterBatch");

        // Delete selected active messages (receive + complete by sequence number)
        group.MapPost("/queues/{queueName}/messages/delete/batch", DeleteQueueMessagesBatch)
            .WithName("DeleteQueueMessagesBatch");

        group.MapPost("/topics/{topicName}/subscriptions/{subscriptionName}/messages/delete/batch", DeleteSubscriptionMessagesBatch)
            .WithName("DeleteSubscriptionMessagesBatch");

        // Cancel selected scheduled messages (by scheduled sequence number)
        group.MapPost("/queues/{queueName}/scheduled/cancel/batch", CancelQueueScheduledBatch)
            .WithName("CancelQueueScheduledBatch");

        group.MapPost("/topics/{topicName}/scheduled/cancel/batch", CancelTopicScheduledBatch)
            .WithName("CancelTopicScheduledBatch");
    }

    private static async Task<IResult> PeekQueueMessages(int connectionId, string queueName, IServiceBusService serviceBusService, [FromQuery] int maxMessages = 50, [FromQuery] bool deadLetter = false, [FromQuery] long? fromSequenceNumber = null)
    {
        // Validate input
        var (valid, error) = ValidationHelper.ValidateMaxMessages(maxMessages);
        if (!valid)
        {
            return Results.BadRequest(new { error });
        }

        var messages = await serviceBusService.PeekMessagesAsync(connectionId, queueName, null, maxMessages, deadLetter, fromSequenceNumber);
        if (messages == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(messages);
    }

    private static async Task<IResult> PeekSubscriptionMessages(int connectionId, string topicName, string subscriptionName, IServiceBusService serviceBusService, [FromQuery] int maxMessages = 50, [FromQuery] bool deadLetter = false, [FromQuery] long? fromSequenceNumber = null)
    {
        // Validate input
        var (valid, error) = ValidationHelper.ValidateMaxMessages(maxMessages);
        if (!valid)
        {
            return Results.BadRequest(new { error });
        }

        var messages = await serviceBusService.PeekMessagesAsync(connectionId, topicName, subscriptionName, maxMessages, deadLetter, fromSequenceNumber);
        if (messages == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(messages);
    }

    private static async Task<IResult> ScanQueueSessions(int connectionId, string queueName, IServiceBusService serviceBusService, [FromQuery] bool deadLetter = false, [FromQuery] long? fromSequenceNumber = null, [FromQuery] int scanLimit = 1000)
    {
        var (valid, error) = ValidationHelper.ValidateMaxMessages(scanLimit);
        if (!valid)
        {
            return Results.BadRequest(new { error });
        }

        var result = await serviceBusService.ScanSessionsAsync(connectionId, queueName, null, deadLetter, fromSequenceNumber, scanLimit);
        if (result == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(result);
    }

    private static async Task<IResult> ScanSubscriptionSessions(int connectionId, string topicName, string subscriptionName, IServiceBusService serviceBusService, [FromQuery] bool deadLetter = false, [FromQuery] long? fromSequenceNumber = null, [FromQuery] int scanLimit = 1000)
    {
        var (valid, error) = ValidationHelper.ValidateMaxMessages(scanLimit);
        if (!valid)
        {
            return Results.BadRequest(new { error });
        }

        var result = await serviceBusService.ScanSessionsAsync(connectionId, topicName, subscriptionName, deadLetter, fromSequenceNumber, scanLimit);
        if (result == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(result);
    }

    private static async Task<IResult> PeekQueueSessionMessages(int connectionId, string queueName, IServiceBusService serviceBusService, [FromQuery] string sessionId, [FromQuery] bool deadLetter = false, [FromQuery] long? fromSequenceNumber = null, [FromQuery] int scanLimit = 1000)
    {
        if (string.IsNullOrEmpty(sessionId))
        {
            return Results.BadRequest(new { error = "sessionId is required" });
        }
        var (valid, error) = ValidationHelper.ValidateMaxMessages(scanLimit);
        if (!valid)
        {
            return Results.BadRequest(new { error });
        }

        var result = await serviceBusService.PeekSessionMessagesAsync(connectionId, queueName, null, sessionId, deadLetter, fromSequenceNumber, scanLimit);
        if (result == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(result);
    }

    private static async Task<IResult> PeekSubscriptionSessionMessages(int connectionId, string topicName, string subscriptionName, IServiceBusService serviceBusService, [FromQuery] string sessionId, [FromQuery] bool deadLetter = false, [FromQuery] long? fromSequenceNumber = null, [FromQuery] int scanLimit = 1000)
    {
        if (string.IsNullOrEmpty(sessionId))
        {
            return Results.BadRequest(new { error = "sessionId is required" });
        }
        var (valid, error) = ValidationHelper.ValidateMaxMessages(scanLimit);
        if (!valid)
        {
            return Results.BadRequest(new { error });
        }

        var result = await serviceBusService.PeekSessionMessagesAsync(connectionId, topicName, subscriptionName, sessionId, deadLetter, fromSequenceNumber, scanLimit);
        if (result == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(result);
    }

    private static async Task<IResult> ReceiveQueueMessages(int connectionId, string queueName, IServiceBusService serviceBusService, CancellationToken cancellationToken, [FromQuery] int maxMessages = 10, [FromQuery] bool deadLetter = false, [FromQuery] string? sessionId = null)
    {
        // Validate input - allow up to 100,000 for consume/purge operations
        var (valid, error) = ValidationHelper.ValidateMaxMessages(maxMessages, 100000);
        if (!valid)
        {
            return Results.BadRequest(new { error });
        }

        var consumedCount = await serviceBusService.ReceiveMessagesAsync(connectionId, queueName, null, maxMessages, deadLetter, sessionId, cancellationToken);
        if (consumedCount == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(new { consumedCount });
    }

    private static async Task<IResult> ReceiveSubscriptionMessages(int connectionId, string topicName, string subscriptionName, IServiceBusService serviceBusService, CancellationToken cancellationToken, [FromQuery] int maxMessages = 10, [FromQuery] bool deadLetter = false, [FromQuery] string? sessionId = null)
    {
        // Validate input - allow up to 100,000 for consume/purge operations
        var (valid, error) = ValidationHelper.ValidateMaxMessages(maxMessages, 100000);
        if (!valid)
        {
            return Results.BadRequest(new { error });
        }

        var consumedCount = await serviceBusService.ReceiveMessagesAsync(connectionId, topicName, subscriptionName, maxMessages, deadLetter, sessionId, cancellationToken);
        if (consumedCount == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(new { consumedCount });
    }

    private static async Task<IResult> SendToQueue(int connectionId, string queueName, SendMessageDto dto, IServiceBusService serviceBusService, [FromQuery] int count = 1)
    {
        // Validate input
        var (valid, error) = ValidationHelper.ValidateMessageBody(dto.Body);
        if (!valid)
        {
            return Results.BadRequest(new { error });
        }
        var (countValid, countError) = ValidationHelper.ValidateSendCount(count);
        if (!countValid)
        {
            return Results.BadRequest(new { error = countError });
        }
        var (propsValid, propsError) = ValidationHelper.ValidateApplicationProperties(dto.ApplicationProperties);
        if (!propsValid)
        {
            return Results.BadRequest(new { error = propsError });
        }

        var sentCount = await serviceBusService.SendMessagesAsync(connectionId, queueName, dto, count);
        if (sentCount == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(new { sentCount });
    }

    private static async Task<IResult> SendToTopic(int connectionId, string topicName, SendMessageDto dto, IServiceBusService serviceBusService, [FromQuery] int count = 1)
    {
        // Validate input
        var (valid, error) = ValidationHelper.ValidateMessageBody(dto.Body);
        if (!valid)
        {
            return Results.BadRequest(new { error });
        }
        var (countValid, countError) = ValidationHelper.ValidateSendCount(count);
        if (!countValid)
        {
            return Results.BadRequest(new { error = countError });
        }
        var (propsValid, propsError) = ValidationHelper.ValidateApplicationProperties(dto.ApplicationProperties);
        if (!propsValid)
        {
            return Results.BadRequest(new { error = propsError });
        }

        var sentCount = await serviceBusService.SendMessagesAsync(connectionId, topicName, dto, count);
        if (sentCount == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(new { sentCount });
    }

    private static async Task<IResult> ReturnQueueDeadLetter(int connectionId, string queueName, long sequenceNumber, [FromBody] SendMessageDto? modifiedMessage, IServiceBusService serviceBusService, [FromQuery] bool deleteOriginal = true)
    {
        var result = await serviceBusService.ReturnDeadLetterMessageAsync(connectionId, queueName, null, sequenceNumber, modifiedMessage, deleteOriginal);
        return result switch
        {
            null => Results.NotFound("Connection not found"),
            false => Results.NotFound("Message not found"),
            true => Results.Ok()
        };
    }

    private static async Task<IResult> ReturnSubscriptionDeadLetter(int connectionId, string topicName, string subscriptionName, long sequenceNumber, [FromBody] SendMessageDto? modifiedMessage, IServiceBusService serviceBusService, [FromQuery] bool deleteOriginal = true)
    {
        var result = await serviceBusService.ReturnDeadLetterMessageAsync(connectionId, topicName, subscriptionName, sequenceNumber, modifiedMessage, deleteOriginal);
        return result switch
        {
            null => Results.NotFound("Connection not found"),
            false => Results.NotFound("Message not found"),
            true => Results.Ok()
        };
    }

    private static async Task<IResult> ReturnQueueDeadLetterBatch(int connectionId, string queueName, [FromBody] long[] sequenceNumbers, IServiceBusService serviceBusService)
    {
        var count = await serviceBusService.ReturnDeadLetterMessagesAsync(connectionId, queueName, null, sequenceNumbers);
        if (count == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(new { processed = count });
    }

    private static async Task<IResult> ReturnSubscriptionDeadLetterBatch(int connectionId, string topicName, string subscriptionName, [FromBody] long[] sequenceNumbers, IServiceBusService serviceBusService)
    {
        var count = await serviceBusService.ReturnDeadLetterMessagesAsync(connectionId, topicName, subscriptionName, sequenceNumbers);
        if (count == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(new { processed = count });
    }

    private static async Task<IResult> ReceiveQueueDeadLetterBatch(int connectionId, string queueName, [FromBody] long[] sequenceNumbers, IServiceBusService serviceBusService, CancellationToken cancellationToken)
    {
        var count = await serviceBusService.ReceiveMessagesBySequenceAsync(connectionId, queueName, null, sequenceNumbers, deadLetter: true, cancellationToken);
        if (count == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(new { processed = count });
    }

    private static async Task<IResult> ReceiveSubscriptionDeadLetterBatch(int connectionId, string topicName, string subscriptionName, [FromBody] long[] sequenceNumbers, IServiceBusService serviceBusService, CancellationToken cancellationToken)
    {
        var count = await serviceBusService.ReceiveMessagesBySequenceAsync(connectionId, topicName, subscriptionName, sequenceNumbers, deadLetter: true, cancellationToken);
        if (count == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(new { processed = count });
    }

    private static async Task<IResult> DeleteQueueMessagesBatch(int connectionId, string queueName, [FromBody] long[] sequenceNumbers, IServiceBusService serviceBusService, CancellationToken cancellationToken)
    {
        var count = await serviceBusService.ReceiveMessagesBySequenceAsync(connectionId, queueName, null, sequenceNumbers, deadLetter: false, cancellationToken);
        if (count == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(new { processed = count });
    }

    private static async Task<IResult> DeleteSubscriptionMessagesBatch(int connectionId, string topicName, string subscriptionName, [FromBody] long[] sequenceNumbers, IServiceBusService serviceBusService, CancellationToken cancellationToken)
    {
        var count = await serviceBusService.ReceiveMessagesBySequenceAsync(connectionId, topicName, subscriptionName, sequenceNumbers, deadLetter: false, cancellationToken);
        if (count == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(new { processed = count });
    }

    private static async Task<IResult> CancelQueueScheduledBatch(int connectionId, string queueName, [FromBody] long[] sequenceNumbers, IServiceBusService serviceBusService)
    {
        var count = await serviceBusService.CancelScheduledMessagesAsync(connectionId, queueName, sequenceNumbers);
        if (count == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(new { processed = count });
    }

    private static async Task<IResult> CancelTopicScheduledBatch(int connectionId, string topicName, [FromBody] long[] sequenceNumbers, IServiceBusService serviceBusService)
    {
        var count = await serviceBusService.CancelScheduledMessagesAsync(connectionId, topicName, sequenceNumbers);
        if (count == null)
        {
            return Results.NotFound("Connection not found");
        }
        return Results.Ok(new { processed = count });
    }
}
