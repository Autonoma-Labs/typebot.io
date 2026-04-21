import { useTranslate } from "@tolgee/react";
import { Button } from "@typebot.io/ui/components/Button";
import { Field } from "@typebot.io/ui/components/Field";
import { Input } from "@typebot.io/ui/components/Input";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { toast } from "@/lib/toast";

type Mode = "signin" | "signup";

export const EmailPasswordForm = ({ redirectPath }: { redirectPath?: string }) => {
  const { t } = useTranslate();
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setIsLoading(true);

    try {
      if (mode === "signup") {
        // Sign up
        const response = await fetch("/api/auth/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, name }),
        });

        const data = await response.json();

        if (!response.ok) {
          toast({
            description: data.error || "Signup failed",
          });
          setIsLoading(false);
          return;
        }

        toast({
          type: "success",
          description: "Account created! Signing you in...",
        });
      }

      // Sign in
      const result = await signIn("credentials", {
        email,
        password,
        redirect: false,
        callbackUrl: redirectPath || "/typebots",
      });

      if (result?.error) {
        toast({
          description: result.error === "CredentialsSignin"
            ? "Invalid email or password"
            : result.error,
        });
        setIsLoading(false);
        return;
      }

      if (result?.url) {
        router.push(result.url);
      }
    } catch (error) {
      toast({
        description: "An error occurred. Please try again.",
      });
      setIsLoading(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      {mode === "signup" && (
        <Field.Root>
          <Field.Label>Name</Field.Label>
          <Input
            name="name"
            type="text"
            placeholder="John Doe"
            value={name}
            onValueChange={setName}
          />
        </Field.Root>
      )}

      <Field.Root>
        <Field.Label>Email</Field.Label>
        <Input
          name="email"
          type="email"
          autoComplete="email"
          placeholder="email@company.com"
          required
          value={email}
          onValueChange={setEmail}
        />
      </Field.Root>

      <Field.Root>
        <Field.Label>Password</Field.Label>
        <Input
          name="password"
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          placeholder={mode === "signup" ? "At least 8 characters" : "Password"}
          required
          minLength={8}
          value={password}
          onValueChange={setPassword}
        />
      </Field.Root>

      <Button
        type="submit"
        disabled={isLoading}
        className="w-full"
      >
        {isLoading ? "Loading..." : mode === "signup" ? "Create Account" : "Sign In"}
      </Button>

      <button
        type="button"
        onClick={() => setMode(mode === "signin" ? "signup" : "signin")}
        className="text-sm text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
      >
        {mode === "signin" ? "Don't have an account? Sign up" : "Already have an account? Sign in"}
      </button>
    </form>
  );
};
