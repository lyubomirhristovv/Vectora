namespace Vectora.Api.Helpers;

// The emulator serves the management API on a separate HTTP port (5300 by default) from the
// AMQP data plane, so the admin client needs the connection string's endpoint pointed there.
public static class EmulatorAdmin
{
    public const int DefaultAdminPort = 5300;

    public static bool IsEmulatorConnectionString(string connectionString)
    {
        return connectionString
            .Split(';', StringSplitOptions.RemoveEmptyEntries)
            .Any(segment =>
            {
                var eq = segment.IndexOf('=');
                return eq >= 0
                    && segment[..eq].Trim().Equals("UseDevelopmentEmulator", StringComparison.OrdinalIgnoreCase)
                    && bool.TryParse(segment[(eq + 1)..].Trim(), out var enabled)
                    && enabled;
            });
    }

    public static string BuildAdminConnectionString(string connectionString, int adminPort = DefaultAdminPort)
    {
        var segments = connectionString.Split(';', StringSplitOptions.RemoveEmptyEntries);
        for (var i = 0; i < segments.Length; i++)
        {
            var segment = segments[i];
            var eq = segment.IndexOf('=');
            if (eq < 0) continue;

            var key = segment[..eq].Trim();
            if (!key.Equals("Endpoint", StringComparison.OrdinalIgnoreCase)) continue;

            var endpoint = segment[(eq + 1)..].Trim();
            if (!Uri.TryCreate(endpoint, UriKind.Absolute, out var uri)) return connectionString;

            segments[i] = $"{key}={uri.Scheme}://{uri.Host}:{adminPort}";
            return string.Join(';', segments);
        }
        return connectionString;
    }
}
