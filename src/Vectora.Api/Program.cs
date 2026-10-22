using Microsoft.EntityFrameworkCore;
using Vectora.Api.Data;
using Vectora.Api.Endpoints;
using Vectora.Api.Helpers;
using Vectora.Api.Middleware;
using Vectora.Api.Repositories;
using Vectora.Api.Services;

var builder = WebApplication.CreateBuilder(args);

var dataPath = Environment.GetEnvironmentVariable("DataPath") ?? "./data";

// Configure SQLite database
Directory.CreateDirectory(dataPath);
var dbPath = Path.Combine(dataPath, "vectora.db");
builder.Services.AddDbContext<VectoraDbContext>(options =>
    options.UseSqlite($"Data Source={dbPath};Cache=Shared;"));

// Add helpers
builder.Services.AddSingleton<IServiceBusClientCache, ServiceBusClientCache>();
builder.Services.AddSingleton<IServiceBusEntityCache, ServiceBusEntityCache>();
builder.Services.AddSingleton<IEmulatorCountRefresher, EmulatorCountRefresher>();

// Add repositories
builder.Services.AddScoped<IConnectionRepository, ConnectionRepository>();
builder.Services.AddScoped<ISettingsRepository, SettingsRepository>();

// Add services
builder.Services.AddSingleton<IJwtService, JwtService>();
builder.Services.AddScoped<IServiceBusService, ServiceBusService>();
builder.Services.AddScoped<ISettingsService, SettingsService>();
builder.Services.AddScoped<IMessageTemplateService, MessageTemplateService>();
builder.Services.AddScoped<ISearchHistoryService, SearchHistoryService>();
builder.Services.AddScoped<IFavoriteEntityService, FavoriteEntityService>();

builder.Services.AddHostedService<EntityCacheWarmupService>();

// CORS for the MCP endpoint so web-based AI clients can reach it from any origin.
builder.Services.AddCors(options =>
    options.AddPolicy("McpCors", policy =>
        policy.AllowAnyOrigin().AllowAnyMethod().AllowAnyHeader()));

// MCP server for AI agents; tools are discovered from [McpServerToolType] classes in this assembly.
builder.Services.AddMcpServer()
    .WithHttpTransport(options => options.Stateless = true)
    .WithToolsFromAssembly();

// Configure request body size limit (10MB max)
builder.WebHost.ConfigureKestrel(options =>
{
    options.Limits.MaxRequestBodySize = 10 * 1024 * 1024; // 10 MB
});

var app = builder.Build();

// Initialize database with migrations
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<VectoraDbContext>();
    db.Database.Migrate();

    // Enable WAL mode for better concurrency and crash recovery
    db.Database.ExecuteSql($"PRAGMA journal_mode = 'WAL';");
    db.Database.ExecuteSql($"PRAGMA busy_timeout = 5000;");
}

// Configure the HTTP request pipeline - order matters!

// 1. Global exception handling (first to catch all errors)
app.UseMiddleware<ExceptionHandlingMiddleware>();

// 2. Security headers
app.UseMiddleware<SecurityHeadersMiddleware>();

// 3. Rate limiting for login
app.UseMiddleware<LoginRateLimitingMiddleware>();

// 4. CORS (must be before endpoint mapping; policy is scoped to /mcp via RequireCors)
app.UseCors();

// 5. Serve static files (frontend)
app.UseDefaultFiles();
app.UseStaticFiles();

// 6. Authentication middleware
app.UseMiddleware<AuthMiddleware>();

// 6. MCP gating (acts only on /mcp; reads enable+key from the DB per request)
app.UseMiddleware<McpAuthMiddleware>();
app.MapMcp("/mcp").RequireCors("McpCors");

// Map minimal API endpoints
app.MapAuthEndpoints();
app.MapConnectionEndpoints();
app.MapServiceBusEndpoints();
app.MapServiceBusMessageEndpoints();
app.MapSettingsEndpoints();
app.MapMessageTemplateEndpoints();
app.MapSearchHistoryEndpoints();
app.MapFavoriteEntityEndpoints();

// Fallback to index.html for SPA routing
app.MapFallbackToFile("index.html");

// Graceful shutdown
var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();
lifetime.ApplicationStopping.Register(async () =>
{
    using var scope = app.Services.CreateScope();
    var db = scope.ServiceProvider.GetRequiredService<VectoraDbContext>();
    await db.Database.CloseConnectionAsync();
});

app.Run();
