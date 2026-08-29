use std::{
    collections::BTreeMap,
    net::{IpAddr, Ipv4Addr, UdpSocket},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NetworkAddress {
    pub interface_name: String,
    pub ip: IpAddr,
    pub is_default_route: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InterfaceObservation {
    pub interface_name: String,
    pub ip: IpAddr,
    pub is_up: bool,
}

pub(crate) trait NetworkInterfaceProvider {
    fn interfaces(&self) -> Result<Vec<InterfaceObservation>, String>;

    fn default_route_ip(&self) -> Option<IpAddr>;
}

pub(crate) fn enumerate_advertised_addresses(
    provider: &impl NetworkInterfaceProvider,
) -> Result<Vec<NetworkAddress>, String> {
    let default_route_ip = provider.default_route_ip().map(normalize_ip);
    let mut addresses = BTreeMap::<IpAddr, NetworkAddress>::new();
    for observation in provider.interfaces()? {
        let ip = normalize_ip(observation.ip);
        if !observation.is_up || !is_usable_unicast(ip) {
            continue;
        }
        let is_default_route = default_route_ip == Some(ip);
        addresses
            .entry(ip)
            .and_modify(|address| address.is_default_route |= is_default_route)
            .or_insert(NetworkAddress {
                interface_name: observation.interface_name,
                ip,
                is_default_route,
            });
    }
    let mut addresses = addresses.into_values().collect::<Vec<_>>();
    addresses.sort_by_key(|address| {
        (
            address_rank(address),
            address.ip.to_string(),
            address.interface_name.clone(),
        )
    });
    Ok(addresses)
}

pub(crate) fn enumerate_system_advertised_addresses() -> Result<Vec<NetworkAddress>, String> {
    enumerate_advertised_addresses(&SystemNetworkInterfaceProvider)
}

pub(crate) fn default_route_ip() -> Option<IpAddr> {
    SystemNetworkInterfaceProvider.default_route_ip()
}

pub(crate) fn is_cgnat_or_tailscale(ip: IpAddr) -> bool {
    match normalize_ip(ip) {
        IpAddr::V4(ipv4) => {
            let octets = ipv4.octets();
            octets[0] == 100 && (64..=127).contains(&octets[1])
        }
        IpAddr::V6(ipv6) => ipv6.segments()[..3] == [0xfd7a, 0x115c, 0xa1e0],
    }
}

pub(crate) fn is_private_network(ip: IpAddr) -> bool {
    match normalize_ip(ip) {
        IpAddr::V4(ipv4) => ipv4.is_private() || is_cgnat_or_tailscale(IpAddr::V4(ipv4)),
        IpAddr::V6(ipv6) => (ipv6.segments()[0] & 0xfe00) == 0xfc00,
    }
}

struct SystemNetworkInterfaceProvider;

impl NetworkInterfaceProvider for SystemNetworkInterfaceProvider {
    fn interfaces(&self) -> Result<Vec<InterfaceObservation>, String> {
        if_addrs::get_if_addrs()
            .map_err(|error| format!("Could not enumerate network interfaces: {error}"))
            .map(|interfaces| {
                interfaces
                    .into_iter()
                    .map(|interface| {
                        let ip = interface.ip();
                        let is_up = interface.is_oper_up();
                        InterfaceObservation {
                            interface_name: interface.name,
                            ip,
                            is_up,
                        }
                    })
                    .collect()
            })
    }

    fn default_route_ip(&self) -> Option<IpAddr> {
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
        socket.connect((Ipv4Addr::new(8, 8, 8, 8), 80)).ok()?;
        Some(normalize_ip(socket.local_addr().ok()?.ip()))
    }
}

fn normalize_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(ipv6) => ipv6.to_ipv4_mapped().map_or(IpAddr::V6(ipv6), IpAddr::V4),
        ipv4 => ipv4,
    }
}

fn is_usable_unicast(ip: IpAddr) -> bool {
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() {
        return false;
    }
    match ip {
        IpAddr::V4(ipv4) => !ipv4.is_link_local() && ipv4.octets() != [u8::MAX; 4],
        IpAddr::V6(ipv6) => !ipv6.is_unicast_link_local(),
    }
}

fn address_rank(address: &NetworkAddress) -> u8 {
    if address.is_default_route {
        0
    } else if is_cgnat_or_tailscale(address.ip) {
        1
    } else if is_private_network(address.ip) {
        2
    } else {
        3
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    struct FixtureProvider {
        interfaces: Vec<InterfaceObservation>,
        default_route_ip: Option<IpAddr>,
    }

    impl NetworkInterfaceProvider for FixtureProvider {
        fn interfaces(&self) -> Result<Vec<InterfaceObservation>, String> {
            Ok(self.interfaces.clone())
        }

        fn default_route_ip(&self) -> Option<IpAddr> {
            self.default_route_ip
        }
    }

    fn observation(interface_name: &str, ip: IpAddr, is_up: bool) -> InterfaceObservation {
        InterfaceObservation {
            interface_name: interface_name.to_string(),
            ip,
            is_up,
        }
    }

    #[test]
    fn filters_deduplicates_and_ranks_all_usable_addresses() {
        let ethernet = IpAddr::V4(Ipv4Addr::new(192, 168, 1, 20));
        let tailnet = IpAddr::V4(Ipv4Addr::new(100, 100, 100, 100));
        let vpn = IpAddr::V4(Ipv4Addr::new(10, 8, 0, 2));
        let global_v6 = IpAddr::V6("2001:db8::20".parse::<Ipv6Addr>().expect("IPv6 fixture"));
        let provider = FixtureProvider {
            interfaces: vec![
                observation("eth0", ethernet, true),
                observation("wifi0", ethernet, true),
                observation("tailscale0", tailnet, true),
                observation("vpn0", vpn, true),
                observation("global-v6", global_v6, true),
                observation("down0", IpAddr::V4(Ipv4Addr::new(172, 16, 0, 4)), false),
                observation("loopback", IpAddr::V4(Ipv4Addr::LOCALHOST), true),
                observation("unspecified", IpAddr::V4(Ipv4Addr::UNSPECIFIED), true),
                observation(
                    "link-local-v4",
                    IpAddr::V4(Ipv4Addr::new(169, 254, 2, 4)),
                    true,
                ),
                observation(
                    "link-local-v6",
                    IpAddr::V6("fe80::20".parse::<Ipv6Addr>().expect("IPv6 fixture")),
                    true,
                ),
            ],
            default_route_ip: Some(ethernet),
        };

        assert_eq!(
            enumerate_advertised_addresses(&provider).expect("fixture enumeration"),
            vec![
                NetworkAddress {
                    interface_name: "eth0".to_string(),
                    ip: ethernet,
                    is_default_route: true,
                },
                NetworkAddress {
                    interface_name: "tailscale0".to_string(),
                    ip: tailnet,
                    is_default_route: false,
                },
                NetworkAddress {
                    interface_name: "vpn0".to_string(),
                    ip: vpn,
                    is_default_route: false,
                },
                NetworkAddress {
                    interface_name: "global-v6".to_string(),
                    ip: global_v6,
                    is_default_route: false,
                },
            ]
        );
    }

    #[test]
    fn normalizes_ipv4_mapped_ipv6_before_deduplication() {
        let ipv4 = IpAddr::V4(Ipv4Addr::new(192, 168, 50, 10));
        let mapped = IpAddr::V6(
            "::ffff:192.168.50.10"
                .parse::<Ipv6Addr>()
                .expect("mapped IPv6"),
        );
        let provider = FixtureProvider {
            interfaces: vec![
                observation("mapped", mapped, true),
                observation("native", ipv4, true),
            ],
            default_route_ip: Some(mapped),
        };

        assert_eq!(
            enumerate_advertised_addresses(&provider).expect("fixture enumeration"),
            vec![NetworkAddress {
                interface_name: "mapped".to_string(),
                ip: ipv4,
                is_default_route: true,
            }]
        );
    }
}
