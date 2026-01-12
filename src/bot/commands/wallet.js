import { users } from '../../database/index.js'
import { isValidAddress, normalizeAddress, formatAddress } from '../../utils/address.js'

export async function handleRegister(interaction) {
  const address = interaction.options.getString('address', true)

  if (!isValidAddress(address)) {
    await interaction.reply({
      content: '**Invalid address**\n\nPlease provide a valid Polygon wallet address (0x...).',
      ephemeral: true,
    })
    return
  }

  const normalizedAddress = normalizeAddress(address)

  if (users.isWalletInUse(normalizedAddress)) {
    await interaction.reply({
      content: '**Address already in use**\n\nThis wallet is registered to another user.',
      ephemeral: true,
    })
    return
  }

  const user = users.getOrCreate(interaction.user.id, interaction.user.username)

  if (user.wallet_address) {
    await interaction.reply({
      content: `**Already registered**\n\nYou already have a wallet: \`${formatAddress(user.wallet_address)}\`\n\nUse \`/update-address\` to change it.`,
      ephemeral: true,
    })
    return
  }

  users.updateWalletAddress(interaction.user.id, normalizedAddress)

  await interaction.reply({
    content: `**Wallet registered!**\n\nYour payout address: \`${formatAddress(normalizedAddress)}\`\n\nYou're now eligible to receive USDC rewards when you make top 3 in predictions.`,
    ephemeral: true,
  })
}

export async function handleUpdateAddress(interaction) {
  const address = interaction.options.getString('address', true)

  if (!isValidAddress(address)) {
    await interaction.reply({
      content: '**Invalid address**\n\nPlease provide a valid Polygon wallet address (0x...).',
      ephemeral: true,
    })
    return
  }

  const user = users.get(interaction.user.id)
  if (!user) {
    await interaction.reply({
      content: '**Not registered**\n\nUse `/register` first to set up your wallet.',
      ephemeral: true,
    })
    return
  }

  const normalizedAddress = normalizeAddress(address)

  if (users.isWalletInUse(normalizedAddress, interaction.user.id)) {
    await interaction.reply({
      content: '**Address already in use**\n\nThis wallet is registered to another user.',
      ephemeral: true,
    })
    return
  }

  const oldAddress = user.wallet_address
  users.updateWalletAddress(interaction.user.id, normalizedAddress)

  await interaction.reply({
    content: [
      `**Wallet updated!**`,
      ``,
      `Old: \`${formatAddress(oldAddress)}\``,
      `New: \`${formatAddress(normalizedAddress)}\``,
      ``,
      `Future payouts will go to your new address.`,
    ].join('\n'),
    ephemeral: true,
  })
}

export async function handleMyAddress(interaction) {
  const user = users.get(interaction.user.id)

  if (!user || !user.wallet_address) {
    await interaction.reply({
      content: '**No wallet registered**\n\nUse `/register` to set up your payout address.',
      ephemeral: true,
    })
    return
  }

  await interaction.reply({
    content: `**Your payout wallet:**\n\`${user.wallet_address}\``,
    ephemeral: true,
  })
}
